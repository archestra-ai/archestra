//! The tray icon on Windows: an icon in the notification area of the taskbar
//! (`Shell_NotifyIconW`). A click on it, left or right, opens the menu. The
//! tooltip and the icon show the state.
//!
//! The icon needs a window for its messages: [`run`] makes a hidden window
//! and runs its message loop on the main thread. The state of the tray is a
//! thread-local of that thread, because the window procedure is a plain
//! function. The icons are the stock icons of Windows: the program has no
//! icon resource.

use std::cell::RefCell;
use std::io;
use std::time::SystemTime;

use tokio::runtime::Runtime;
use tracing::warn;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow,
    DispatchMessageW, GetCursorPos, GetMessageW, HICON, IDI_APPLICATION, IDI_ERROR,
    IDI_INFORMATION, IDI_WARNING, LoadIconW, MF_GRAYED, MF_SEPARATOR, MF_STRING, MSG, PostMessageW,
    PostQuitMessage, RegisterClassExW, RegisterWindowMessageW, SetForegroundWindow, SetTimer,
    TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu, TranslateMessage, WM_APP,
    WM_DESTROY, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WM_TIMER, WNDCLASSEXW, WS_OVERLAPPED,
};

use super::{
    MenuModel, OPEN_DEVICES_ITEM, QUIT_ITEM, REFRESH_INTERVAL, SHUTDOWN_WAIT, SYNC_ITEM,
    devices_url, status_text,
};
use crate::bridge::BridgeHandle;
use crate::bridge::open_url::open_url;
use crate::bridge::state::BridgeStatus;
use crate::bridge::win32::wide;

#[derive(Debug, thiserror::Error)]
pub enum TrayError {
    #[error("cannot make the window of the tray icon: {0}")]
    Window(#[source] io::Error),
    #[error("cannot add the tray icon: {0}")]
    Icon(#[source] io::Error),
}

const CLASS_NAME: &str = "ArchestraMcpBridgeTray";
/// The message that the icon sends to the window.
const ICON_MESSAGE: u32 = WM_APP + 1;
/// The id of the icon of this window, and of its refresh timer.
const ICON_ID: u32 = 1;
const TIMER_ID: usize = 1;
/// The command ids of the menu items. 0 is "no item".
const SYNC_COMMAND: usize = 1;
const OPEN_DEVICES_COMMAND: usize = 2;
const QUIT_COMMAND: usize = 3;

/// The state of the tray, on the thread of the message loop.
struct Tray {
    window: HWND,
    bridge: BridgeHandle,
    /// The address of the Device tab of Personal Settings in Archestra.
    devices_url: String,
    /// What the icon and the tooltip show now.
    shown: Option<BridgeStatus>,
    /// The runtime of the tunnel client. Quit takes it and shuts it down.
    runtime: Option<Runtime>,
    /// Explorer sends it when it starts again: the icon must be added again.
    taskbar_created: u32,
}

thread_local! {
    static TRAY: RefCell<Option<Tray>> = const { RefCell::new(None) };
}

/// Shows the tray icon and runs the message loop. It returns when the user
/// picks Quit, or when the tunnel client ended (the state of `bridge`
/// closes). `base_url` is the address of Archestra, for "Open Device tab".
pub fn run(runtime: Runtime, bridge: BridgeHandle, base_url: &str) -> Result<(), TrayError> {
    let window = make_window().map_err(TrayError::Window)?;
    let name = wide("TaskbarCreated");
    // SAFETY: the name is a NUL-terminated UTF-16 string.
    let taskbar_created = unsafe { RegisterWindowMessageW(name.as_ptr()) };
    TRAY.with_borrow_mut(|tray| {
        *tray = Some(Tray {
            window,
            bridge,
            devices_url: devices_url(base_url),
            shown: None,
            runtime: Some(runtime),
            taskbar_created,
        });
    });
    let status = current_status();
    if let Err(error) = notify_icon(window, NIM_ADD, status) {
        // SAFETY: the window is ours.
        unsafe { DestroyWindow(window) };
        return Err(TrayError::Icon(error));
    }
    TRAY.with_borrow_mut(|tray| {
        if let Some(tray) = tray {
            tray.shown = Some(status);
        }
    });
    // SAFETY: the window is ours; no timer procedure: WM_TIMER comes to it.
    unsafe { SetTimer(window, TIMER_ID, REFRESH_INTERVAL.as_millis() as u32, None) };

    let mut message = MSG::default();
    // SAFETY: `message` is a valid MSG for each call. GetMessageW returns 0
    // at WM_QUIT and -1 on an error.
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

/// A hidden top-level window: it gets the messages of the icon, of the
/// timer, and the "TaskbarCreated" broadcast (a message-only window does
/// not get broadcasts).
fn make_window() -> io::Result<HWND> {
    let class_name = wide(CLASS_NAME);
    // SAFETY: null: the module of this program.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(window_procedure),
        hInstance: instance,
        lpszClassName: class_name.as_ptr(),
        ..WNDCLASSEXW::default()
    };
    // SAFETY: the class is filled in, and its strings live for the call.
    if unsafe { RegisterClassExW(&class) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let title = wide("Archestra MCP bridge");
    // SAFETY: the class is registered; the strings live for the call. The
    // window is never shown.
    let window = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if window.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(window)
}

/// The window procedure. It never holds the borrow of [`TRAY`] while it
/// calls a function that dispatches messages (the menu, `DestroyWindow`):
/// that would call it again.
unsafe extern "system" fn window_procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_TIMER => refresh(),
        ICON_MESSAGE => {
            // The low word of `lparam` is the mouse message on the icon.
            let mouse = (lparam & 0xffff) as u32;
            if mouse == WM_LBUTTONUP || mouse == WM_RBUTTONUP {
                show_menu(window);
            }
        }
        WM_DESTROY => {
            // SAFETY: plain call: it ends the message loop of `run`.
            unsafe { PostQuitMessage(0) };
        }
        _ if message != 0 && message == taskbar_created() => {
            if let Err(error) = notify_icon(window, NIM_ADD, current_status()) {
                warn!(%error, "cannot add the tray icon again");
            }
        }
        // SAFETY: the arguments are those that Windows gave.
        _ => return unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
    0
}

fn taskbar_created() -> u32 {
    TRAY.with_borrow(|tray| tray.as_ref().map_or(0, |tray| tray.taskbar_created))
}

/// The status of the tunnel client. A closed state (the client ended) shows
/// as the last status it had.
fn current_status() -> BridgeStatus {
    TRAY.with_borrow(|tray| {
        tray.as_ref().map_or(BridgeStatus::Starting, |tray| {
            tray.bridge.state.borrow().status
        })
    })
}

/// Brings the icon and the tooltip up to date. Ends the program when the
/// tunnel client stopped (SIGTERM, the stop request of `bridge stop`).
fn refresh() {
    enum Next {
        Nothing,
        Show(HWND, BridgeStatus),
        ShutDown,
    }
    let next = TRAY.with_borrow_mut(|tray| {
        let Some(tray) = tray else {
            return Next::Nothing;
        };
        if tray.bridge.state.has_changed().is_err() {
            return Next::ShutDown;
        }
        let status = tray.bridge.state.borrow().status;
        if tray.shown == Some(status) {
            return Next::Nothing;
        }
        tray.shown = Some(status);
        Next::Show(tray.window, status)
    });
    match next {
        Next::Nothing => {}
        Next::Show(window, status) => {
            if let Err(error) = notify_icon(window, NIM_MODIFY, status) {
                warn!(%error, "cannot change the tray icon");
            }
        }
        Next::ShutDown => shut_down(),
    }
}

/// Builds the menu from the state, shows it at the pointer, and does what the
/// user picked.
fn show_menu(window: HWND) {
    let Some(model) = TRAY.with_borrow(|tray| {
        tray.as_ref()
            .map(|tray| MenuModel::of(&tray.bridge.state.borrow(), SystemTime::now()))
    }) else {
        return;
    };
    let command = popup(window, &model);
    match command {
        SYNC_COMMAND => TRAY.with_borrow(|tray| {
            if let Some(tray) = tray {
                tray.bridge.sync_now();
            }
        }),
        OPEN_DEVICES_COMMAND => {
            let url = TRAY.with_borrow(|tray| tray.as_ref().map(|tray| tray.devices_url.clone()));
            if let Some(url) = url
                && !open_url(&url)
            {
                warn!("could not open the Device tab in the browser");
            }
        }
        QUIT_COMMAND => shut_down(),
        _ => {}
    }
}

/// Shows the menu of `model` and returns the command id that the user
/// picked, or 0.
fn popup(window: HWND, model: &MenuModel) -> usize {
    // SAFETY: plain call; null is the failure.
    let menu = unsafe { CreatePopupMenu() };
    if menu.is_null() {
        return 0;
    }
    let info = |text: &str| {
        let text = wide(text);
        // SAFETY: the menu is valid; the text lives for the call (the menu
        // copies it).
        unsafe { AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, text.as_ptr()) };
    };
    let separator = || {
        // SAFETY: the menu is valid; a separator has no text.
        unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null()) };
    };
    info(status_text(model.status));
    info(&model.config_line);
    if let Some(update_line) = &model.update_line {
        info(update_line);
    }
    if !model.server_lines.is_empty() {
        separator();
        for line in &model.server_lines {
            info(line);
        }
    }
    separator();
    for (title, command) in [
        (SYNC_ITEM, SYNC_COMMAND),
        (OPEN_DEVICES_ITEM, OPEN_DEVICES_COMMAND),
        (QUIT_ITEM, QUIT_COMMAND),
    ] {
        let title = wide(title);
        // SAFETY: as above.
        unsafe { AppendMenuW(menu, MF_STRING, command, title.as_ptr()) };
    }

    let mut point = POINT::default();
    // SAFETY: the menu and the window are valid. The window must be in the
    // foreground, or the menu does not close when the user clicks elsewhere;
    // the WM_NULL after it is the documented companion of that.
    let picked = unsafe {
        GetCursorPos(&mut point);
        SetForegroundWindow(window);
        let picked = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
            point.x,
            point.y,
            0,
            window,
            std::ptr::null(),
        );
        PostMessageW(window, WM_NULL, 0, 0);
        DestroyMenu(menu);
        picked
    };
    usize::try_from(picked).unwrap_or(0)
}

/// Stops the tunnel client and its MCP servers, removes the icon, and ends
/// the message loop.
fn shut_down() {
    let Some((window, runtime)) =
        TRAY.with_borrow_mut(|tray| tray.as_mut().map(|tray| (tray.window, tray.runtime.take())))
    else {
        return;
    };
    if let Some(runtime) = runtime {
        runtime.shutdown_timeout(SHUTDOWN_WAIT);
    }
    let _ = notify_icon(window, NIM_DELETE, BridgeStatus::Starting);
    // SAFETY: the window is ours. WM_DESTROY then ends the message loop.
    unsafe { DestroyWindow(window) };
}

/// Adds, changes or removes the icon of `window`, with the icon and the
/// tooltip of `status`.
fn notify_icon(window: HWND, action: u32, status: BridgeStatus) -> io::Result<()> {
    let mut data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: window,
        uID: ICON_ID,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: ICON_MESSAGE,
        hIcon: stock_icon(status),
        ..NOTIFYICONDATAW::default()
    };
    // The tooltip holds 127 characters and the NUL.
    for (slot, unit) in data
        .szTip
        .iter_mut()
        .zip(status_text(status).encode_utf16().take(127))
    {
        *slot = unit;
    }
    // SAFETY: `data` is filled in and lives for the call.
    if unsafe { Shell_NotifyIconW(action, &data) } == 0 {
        return Err(io::Error::other("Shell_NotifyIconW failed"));
    }
    Ok(())
}

fn stock_icon(status: BridgeStatus) -> HICON {
    let icon = match status {
        BridgeStatus::Starting => IDI_APPLICATION,
        BridgeStatus::Connected => IDI_INFORMATION,
        BridgeStatus::Disconnected => IDI_WARNING,
        BridgeStatus::SignedOut => IDI_ERROR,
    };
    // SAFETY: a stock icon: no module, and an id in place of a name.
    unsafe { LoadIconW(std::ptr::null_mut(), icon) }
}
