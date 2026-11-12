//! Opens an address in the browser of the user: the approval page of the
//! sign-in, and "Open Device tab" of the tray menu.

/// Opens `url` in the default browser. Returns false when that did not work;
/// the caller then tells the user to open it by hand.
pub(crate) fn open_url(url: &str) -> bool {
    #[cfg(windows)]
    {
        windows::open(url)
    }
    #[cfg(not(windows))]
    {
        // `open` on macOS, the desktop-neutral `xdg-open` on Linux.
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(program)
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use crate::bridge::win32::wide;

    /// The shell opens the address with the default browser. No `cmd /c
    /// start`: the `&` of a query string would end the command there.
    pub(super) fn open(url: &str) -> bool {
        let operation = wide("open");
        let file = wide(url);
        // SAFETY: both strings are NUL-terminated UTF-16 that live for the
        // call; the other pointers may be null.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // A value above 32 is a success.
        result as isize > 32
    }
}
