//! The process tree of a stdio MCP server.
//!
//! On Windows a command such as `npx -y some-mcp-server` starts `cmd.exe`
//! (for `npx.cmd`), which starts `node`. Killing the process that the client
//! started leaves the others running. So each MCP server gets a job object
//! that kills every process in it when its last handle closes. The processes
//! that the server starts are in the job as well. The client holds the
//! handle as long as the server runs: a restart, a stop, the end of the
//! client, and `archestra bridge stop` all close it, and Windows ends the
//! tree.
//!
//! The server is put in the job just after it starts. A process that it
//! starts in that short time is not in the job.
//!
//! On macOS and Linux the two calls do nothing: the client kills the process
//! that it started.

use tokio::process::{Child, Command};

/// The processes of one MCP server. Dropping it ends them on Windows.
#[derive(Debug)]
pub(crate) struct ProcessTree {
    /// The job object. `None`: the MCP server could not be put in one.
    #[cfg(windows)]
    _job: Option<std::os::windows::io::OwnedHandle>,
}

/// Sets what the start of an MCP server needs. Windows: no console window.
/// The bridge in the background has no console, and a console program that
/// it starts would otherwise open a window of its own.
#[cfg(windows)]
pub(crate) fn configure(command: &mut Command) {
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn configure(_command: &mut Command) {}

/// Takes the process tree of a child that just started.
#[cfg(windows)]
pub(crate) fn attach(child: &Child) -> ProcessTree {
    let job = child.raw_handle().and_then(|process| {
        kill_on_close_job(process)
            .inspect_err(|error| {
                tracing::warn!(%error, "the processes that the MCP server starts may outlive it");
            })
            .ok()
    });
    ProcessTree { _job: job }
}

#[cfg(not(windows))]
pub(crate) fn attach(_child: &Child) -> ProcessTree {
    ProcessTree {}
}

/// Makes a job object that ends its processes when its handle closes, and
/// puts the process `process` (a handle of a child) in it.
#[cfg(windows)]
fn kill_on_close_job(
    process: std::os::windows::io::RawHandle,
) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };

    use crate::bridge::win32::owned_handle;

    // SAFETY: no attributes and no name: an anonymous job.
    let job = owned_handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the job handle is valid, and the pointer and the size are
    // those of `limits`, which lives for the call.
    let limited = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if limited == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both handles are valid: the job above, and the process handle
    // of a child that the caller holds.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(job)
}
