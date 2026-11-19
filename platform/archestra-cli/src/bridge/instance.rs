//! The MCP bridge that runs in the background on Windows and on Linux (with
//! the XDG autostart): one at a time, and `archestra bridge stop` finds it.
//! launchd and systemd know their job by themselves.
//!
//! The MCP bridge holds a lock on `~/.archestra/mcp-bridge/mcp-bridge.lock`
//! while it runs and writes its process id to `mcp-bridge.pid`. The OS frees
//! the lock when the process ends, in any way. So:
//!
//! - A held lock means that the MCP bridge runs, and the process id is the
//!   one of that MCP bridge, not of a later process that got the same number.
//!   An old pid file of a process that ended is never used.
//! - A second MCP bridge in the background does not get the lock, and ends.
//!
//! [`stop_running`] asks the MCP bridge to stop and waits until the lock is
//! free: on Linux with SIGTERM, on Windows with the named event
//! `Local\ArchestraMcpBridgeStop` that the MCP bridge waits for. Both are
//! normal ends: the MCP bridge stops its MCP servers. A Windows MCP bridge
//! that does not stop in time is terminated; its job objects then end the MCP
//! servers.

use std::fs::{self, File, TryLockError};
use std::io;
use std::path::Path;
use std::time::Duration;

use crate::bridge::files;
use crate::bridge::wait::wait_until;
use crate::layout;

/// How often [`stop_running`] and [`running_pid`] look at the lock.
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// The tries of [`InstanceLock::acquire`] when the lock is held.
const ACQUIRE_TRIES: u32 = 5;
const ACQUIRE_PAUSE: Duration = Duration::from_millis(60);
/// How long [`running_pid`] waits for the process id of a new holder.
const PID_WAIT: Duration = Duration::from_secs(1);

/// The lock of the MCP bridge in the background. The MCP bridge holds it for
/// as long as it runs.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    /// Takes the lock and writes the process id of this process. `None`: a
    /// different MCP bridge in the background has it.
    pub fn acquire(home: &Path) -> io::Result<Option<Self>> {
        let lock_path = layout::bridge_lock_path(home);
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = open_lock_file(&lock_path, true)?;
        // [`is_running`] holds the lock for a moment when it looks: a few
        // tries, so that a look is not taken for a running MCP bridge.
        let mut tries = 0;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) if tries < ACQUIRE_TRIES => {
                    tries += 1;
                    std::thread::sleep(ACQUIRE_PAUSE);
                }
                Err(TryLockError::WouldBlock) => return Ok(None),
                Err(TryLockError::Error(error)) => return Err(error),
            }
        }
        // In one step: a reader never sees a half-written id.
        files::replace_file(&layout::bridge_pid_path(home), |temporary| {
            fs::write(temporary, std::process::id().to_string())
        })?;
        Ok(Some(Self { _file: file }))
    }
}

/// `true` while an MCP bridge in the background holds the lock.
pub fn is_running(home: &Path) -> io::Result<bool> {
    let file = match open_lock_file(&layout::bridge_lock_path(home), false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match file.try_lock() {
        // Nobody holds it. Dropping the file frees it again.
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

/// The process id of the MCP bridge in the background. `None`: none runs.
///
/// The MCP bridge writes its id (with a rename) just after it takes the lock.
/// A look in that short time finds no file and waits a moment for it. It can
/// also find the id of the MCP bridge before it: that window is the time of
/// one file write, and an id that no process has gets no signal.
fn running_pid(home: &Path) -> io::Result<Option<u32>> {
    let pid_path = layout::bridge_pid_path(home);
    // The value of the wait: `None` when no MCP bridge runs, else its id.
    let found = wait_until(PID_WAIT, POLL_INTERVAL, || -> io::Result<_> {
        if !is_running(home)? {
            return Ok(Some(None));
        }
        let pid = fs::read_to_string(&pid_path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok());
        Ok(pid.map(Some))
    })?;
    found.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the MCP bridge holds the lock but wrote no process id",
        )
    })
}

/// Stops the MCP bridge in the background and waits until it ended. `false`:
/// none ran.
pub fn stop_running(home: &Path, timeout: Duration) -> io::Result<bool> {
    let Some(pid) = running_pid(home)? else {
        return Ok(false);
    };
    ask_to_stop(pid)?;
    if wait_until_stopped(home, timeout)? {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        tracing::warn!(pid, "the MCP bridge did not stop in time; terminating it");
        windows::terminate(pid)?;
        if wait_until_stopped(home, timeout)? {
            return Ok(true);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("the MCP bridge (process {pid}) did not stop"),
    ))
}

fn wait_until_stopped(home: &Path, timeout: Duration) -> io::Result<bool> {
    let stopped = wait_until(timeout, POLL_INTERVAL, || -> io::Result<_> {
        Ok((!is_running(home)?).then_some(()))
    })?;
    Ok(stopped.is_some())
}

fn open_lock_file(path: &Path, create: bool) -> io::Result<File> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .open(path)
}

/// SIGTERM: the MCP bridge stops as with Ctrl-C.
#[cfg(unix)]
fn ask_to_stop(pid: u32) -> io::Result<()> {
    use rustix::process::{Pid, Signal, kill_process};

    let pid = i32::try_from(pid)
        .ok()
        .and_then(Pid::from_raw)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not a process id"))?;
    match kill_process(pid, Signal::TERM) {
        // It ended in the meantime.
        Err(rustix::io::Errno::SRCH) => Ok(()),
        result => result.map_err(io::Error::from),
    }
}

#[cfg(windows)]
fn ask_to_stop(_pid: u32) -> io::Result<()> {
    windows::request_stop()
}

#[cfg(windows)]
pub use windows::StopRequests;

#[cfg(windows)]
mod windows {
    use std::io;
    use std::os::windows::io::{AsRawHandle, OwnedHandle};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, EVENT_MODIFY_STATE, INFINITE, OpenEventW, OpenProcess, PROCESS_TERMINATE,
        ResetEvent, SetEvent, TerminateProcess, WaitForSingleObject,
    };

    use crate::bridge::win32::{owned_handle, wide};

    /// Local: the session of the user who is logged in.
    const STOP_EVENT: &str = r"Local\ArchestraMcpBridgeStop";

    /// The stop requests of `archestra bridge stop`, for the MCP bridge in
    /// the background. Make it after [`super::InstanceLock::acquire`].
    #[derive(Debug)]
    pub struct StopRequests {
        event: OwnedHandle,
    }

    impl StopRequests {
        pub fn listen() -> io::Result<Self> {
            let name = wide(STOP_EVENT);
            // SAFETY: no attributes; manual reset, not set; the name is a
            // NUL-terminated UTF-16 string that lives for the call.
            let event =
                owned_handle(unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) })?;
            // This process holds the lock, so an MCP bridge that was asked to
            // stop has ended: its request is old.
            // SAFETY: the handle is a valid event handle.
            unsafe { ResetEvent(event.as_raw_handle()) };
            Ok(Self { event })
        }

        /// Blocks until `archestra bridge stop` asks for a stop.
        pub fn wait(&self) -> io::Result<()> {
            // SAFETY: the handle is a valid event handle for this call.
            match unsafe { WaitForSingleObject(self.event.as_raw_handle(), INFINITE) } {
                WAIT_OBJECT_0 => Ok(()),
                _ => Err(io::Error::last_os_error()),
            }
        }
    }

    pub(super) fn request_stop() -> io::Result<()> {
        let name = wide(STOP_EVENT);
        // SAFETY: the name is a NUL-terminated UTF-16 string that lives for
        // the call.
        let event = match owned_handle(unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) })
        {
            Ok(event) => event,
            // The MCP bridge ended in the meantime.
            Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        // SAFETY: the handle is a valid event handle with EVENT_MODIFY_STATE.
        if unsafe { SetEvent(event.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Ends the process at once. Its job objects close, so its MCP servers
    /// end as well.
    pub(super) fn terminate(pid: u32) -> io::Result<()> {
        // SAFETY: plain call; a null handle is the failure.
        let process = owned_handle(unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) })?;
        // SAFETY: the handle is a valid process handle with PROCESS_TERMINATE.
        if unsafe { TerminateProcess(process.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_holder_at_a_time_and_its_pid() {
        let home = tempfile::tempdir().expect("temp home");
        assert_eq!(running_pid(home.path()).expect("look"), None);

        let lock = InstanceLock::acquire(home.path())
            .expect("acquire")
            .expect("free");
        assert!(
            InstanceLock::acquire(home.path())
                .expect("acquire again")
                .is_none(),
            "a second MCP bridge does not get the lock"
        );
        assert_eq!(
            running_pid(home.path()).expect("look"),
            Some(std::process::id())
        );

        drop(lock);
        // A process that a parallel test forks holds a copy of the lock until
        // its `exec`: wait for that short time.
        assert!(wait_until_stopped(home.path(), Duration::from_secs(10)).expect("wait"));
        assert!(
            InstanceLock::acquire(home.path())
                .expect("acquire after the end")
                .is_some()
        );
    }

    #[test]
    fn an_old_pid_file_with_no_lock_is_not_a_running_bridge() {
        let home = tempfile::tempdir().expect("temp home");
        let lock = InstanceLock::acquire(home.path())
            .expect("acquire")
            .expect("free");
        drop(lock);
        assert!(wait_until_stopped(home.path(), Duration::from_secs(10)).expect("wait"));
        // A process id that no process has.
        fs::write(layout::bridge_pid_path(home.path()), "999999999").expect("write");

        assert_eq!(running_pid(home.path()).expect("look"), None);
        assert!(!stop_running(home.path(), Duration::from_secs(1)).expect("stop"));
    }

    /// A process that holds the lock as the MCP bridge does, and ends at
    /// SIGTERM.
    #[cfg(unix)]
    #[test]
    fn stop_running_ends_the_holder_with_sigterm() {
        let home = tempfile::tempdir().expect("temp home");
        let lock_path = layout::bridge_lock_path(home.path());
        fs::create_dir_all(lock_path.parent().expect("parent")).expect("mkdir");
        let holder = r#"
import fcntl, os, sys, time
lock = open(sys.argv[1], "a")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(sys.argv[2], "w") as pid_file:
    pid_file.write(str(os.getpid()))
while True:
    time.sleep(1)
"#;
        let mut child = std::process::Command::new("python3")
            .args(["-c", holder])
            .arg(&lock_path)
            .arg(layout::bridge_pid_path(home.path()))
            .spawn()
            .expect("python3 starts");
        let held = wait_until(
            Duration::from_secs(30),
            Duration::from_millis(20),
            || -> io::Result<_> {
                Ok((running_pid(home.path())? == Some(child.id())).then_some(()))
            },
        );
        assert_eq!(held.expect("look"), Some(()), "the holder took the lock");

        assert!(stop_running(home.path(), Duration::from_secs(30)).expect("stop"));
        assert_eq!(running_pid(home.path()).expect("look"), None);
        let status = child.wait().expect("wait");
        assert!(!status.success(), "ended by the signal: {status:?}");
    }
}
