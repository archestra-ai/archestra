use once_cell::sync::OnceCell;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

pub const OLLAMA_SERVER_PORT: u16 = 54588;

// Global app handle for emitting events
static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();

pub struct Service {
    app_handle: AppHandle,
}

impl Service {
    pub fn new(app_handle: AppHandle) -> Self {
        // Store app handle globally for the proxy handler
        let _ = APP_HANDLE.set(app_handle.clone());

        Self { app_handle }
    }

    pub async fn start_server_on_startup(&self) -> Result<(), String> {
        use tauri_plugin_shell::process::CommandEvent;

        println!("Starting Ollama server as sidecar on port {OLLAMA_SERVER_PORT}...");

        let sidecar_result = self
            .app_handle
            .shell()
            .sidecar("ollama-v0.9.6")
            .map_err(|e| format!("Failed to get sidecar: {e:?}"))?
            .env("OLLAMA_HOST", format!("127.0.0.1:{OLLAMA_SERVER_PORT}"))
            // Allow (proxied) requests from the archestra server
            .env("OLLAMA_ORIGINS", "http://localhost:54587")
            .env("OLLAMA_DEBUG", "0")
            .args(["serve"])
            .spawn();

        match sidecar_result {
            Ok((mut rx, _child)) => {
                println!("Ollama server started successfully on port {OLLAMA_SERVER_PORT}!");

                // Handle output in background
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line_bytes) => {
                                let line = String::from_utf8_lossy(&line_bytes);
                                print!("[Ollama stdout] {line}");
                            }
                            CommandEvent::Stderr(line_bytes) => {
                                let line = String::from_utf8_lossy(&line_bytes);
                                eprint!("[Ollama stderr] {line}");
                            }
                            _ => {}
                        }
                    }
                });

                Ok(())
            }
            Err(e) => {
                let error_msg = format!("Failed to start Ollama server: {e:?}");
                eprintln!("{error_msg}");
                Err(error_msg)
            }
        }
    }
}

// Helper function for the proxy handler to get the app handle
pub fn get_app_handle() -> Option<&'static AppHandle> {
    APP_HANDLE.get()
}

// Helper function to emit chat title updates
pub fn emit_chat_title_updated(chat_id: i32, title: String) {
    if let Some(handle) = get_app_handle() {
        let _ = handle.emit(
            "chat-title-updated",
            serde_json::json!({
                "chatId": chat_id,
                "title": title
            }),
        );
    }
}
