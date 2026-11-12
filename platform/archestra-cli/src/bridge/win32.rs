//! Small helpers for the Windows API calls of the MCP bridge.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::HANDLE;

/// `text` as NUL-terminated UTF-16, the string form of the `W` functions.
pub(crate) fn wide(text: impl AsRef<OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain([0]).collect()
}

/// Takes a handle that a `Create…` or `Open…` function returned. Null (the
/// failure value of those functions) is `None`, with the error of the call.
pub(crate) fn owned_handle(handle: HANDLE) -> std::io::Result<OwnedHandle> {
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the handle is valid and nothing else owns it: the caller just
    // got it from the function that made it.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
