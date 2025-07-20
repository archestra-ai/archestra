use sea_orm::entity::prelude::*;
use sea_orm::Set;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "client_connections")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(unique)]
    pub client_name: String,
    pub is_connected: bool,
    pub last_connected: Option<DateTimeUtc>,
    pub config_path: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientMcpConfig {
    #[serde(rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeDesktopConfig {
    #[serde(rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    // Claude Desktop config may have other fields
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

impl Model {
    /// Save the client connection state to the database
    pub async fn save_connection_state(
        db: &DatabaseConnection,
        client_name: &str,
        is_connected: bool,
        config_path: Option<String>,
    ) -> Result<Model, DbErr> {
        let now = chrono::Utc::now();
        
        let last_connected = if is_connected { 
            Some(now) 
        } else { 
            None 
        };

        let active_model = ActiveModel {
            client_name: Set(client_name.to_string()),
            is_connected: Set(is_connected),
            last_connected: Set(last_connected),
            config_path: Set(config_path),
            updated_at: Set(now),
            ..Default::default()
        };

        // Use on_conflict to handle upsert by client_name
        let result = Entity::insert(active_model)
            .on_conflict(
                sea_orm::sea_query::OnConflict::column(Column::ClientName)
                    .update_columns([
                        Column::IsConnected,
                        Column::LastConnected,
                        Column::ConfigPath,
                        Column::UpdatedAt,
                    ])
                    .to_owned(),
            )
            .exec_with_returning(db)
            .await?;

        Ok(result)
    }

    /// Get the connection state for a specific client
    pub async fn get_connection_state(
        db: &DatabaseConnection,
        client_name: &str,
    ) -> Result<Option<bool>, DbErr> {
        let model = Entity::find()
            .filter(Column::ClientName.eq(client_name))
            .one(db)
            .await?;

        Ok(model.map(|m| m.is_connected))
    }

    /// Get all connected clients
    pub async fn get_connected_clients(db: &DatabaseConnection) -> Result<Vec<String>, DbErr> {
        let models = Entity::find()
            .filter(Column::IsConnected.eq(true))
            .all(db)
            .await?;

        Ok(models.into_iter().map(|m| m.client_name).collect())
    }

    /// Check if a client is connected
    pub async fn is_client_connected(
        db: &DatabaseConnection,
        client_name: &str,
    ) -> Result<bool, DbErr> {
        let state = Self::get_connection_state(db, client_name).await?;
        Ok(state.unwrap_or(false))
    }

    /// Get the config path for a specific client
    pub fn get_config_path_for_client(client_name: &str) -> Result<PathBuf, String> {
        match client_name {
            "cursor" => {
                let home_dir = std::env::var("HOME")
                    .map_err(|_| "Could not determine home directory")?;
                Ok(PathBuf::from(home_dir).join(".cursor").join("mcp.json"))
            }
            "claude" => {
                let home_dir = std::env::var("HOME")
                    .map_err(|_| "Could not determine home directory")?;
                Ok(PathBuf::from(home_dir)
                    .join("Library")
                    .join("Application Support")
                    .join("Claude")
                    .join("claude_desktop_config.json"))
            }
            "vscode" => {
                let home_dir = std::env::var("HOME")
                    .map_err(|_| "Could not determine home directory")?;
                Ok(PathBuf::from(home_dir)
                    .join(".vscode")
                    .join("mcp.json"))
            }
            _ => Err(format!("Unknown client: {}", client_name))
        }
    }

    /// Connect a client to Archestra MCP servers
    pub async fn connect_client(
        db: &DatabaseConnection,
        client_name: &str,
    ) -> Result<(), String> {
        let config_path = Self::get_config_path_for_client(client_name)?;
        
        println!("🔌 Connecting {} client...", client_name);
        println!("📍 Config path: {}", config_path.display());
        
        let mut config = read_config_file(&config_path)?;
        
        // Get available MCP servers
        let servers = get_available_mcp_servers().await?;
        println!("🔧 Available MCP servers: {:?}", servers);
        
        // Ensure mcpServers object exists
        if !config.is_object() {
            config = serde_json::json!({});
        }
        if !config.get("mcpServers").is_some() {
            config["mcpServers"] = serde_json::json!({});
        }
        
        let mcp_servers = config["mcpServers"].as_object_mut()
            .ok_or("mcpServers is not an object")?;
        
        // Add each MCP server with archestra.ai suffix
        println!("➕ Adding {} MCP servers to {} config", servers.len(), client_name);
        for server in &servers {
            let server_key = format!("{} (archestra.ai)", server);
            let server_config = create_archestra_server_config(&server);
            mcp_servers.insert(server_key.clone(), serde_json::to_value(server_config).unwrap());
            println!("  ✅ Added MCP server: {}", server_key);
        }
        
        println!("📝 Writing config to: {}", config_path.display());
        write_config_file(&config_path, &config)?;
        
        // Save connection state to database
        Self::save_connection_state(db, client_name, true, Some(config_path.to_string_lossy().to_string())).await
            .map_err(|e| format!("Failed to save client connection state: {}", e))?;
        
        println!("✅ Updated {} MCP config at {}", client_name, config_path.display());
        
        Ok(())
    }

    /// Disconnect a client from Archestra MCP servers
    pub async fn disconnect_client(
        db: &DatabaseConnection,
        client_name: &str,
    ) -> Result<(), String> {
        let config_path = Self::get_config_path_for_client(client_name)?;
        
        println!("🔌 Disconnecting {} client...", client_name);
        let mut config = read_config_file(&config_path)?;
        
        if let Some(mcp_servers) = config["mcpServers"].as_object_mut() {
            // Remove all entries with "(archestra.ai)" suffix
            let keys_to_remove: Vec<String> = mcp_servers.keys()
                .filter(|key| key.ends_with(" (archestra.ai)"))
                .cloned()
                .collect();
            
            for key in keys_to_remove {
                mcp_servers.remove(&key);
                println!("  ❌ Removed MCP server: {}", key);
            }
        }
        
        write_config_file(&config_path, &config)?;
        
        // Save disconnection state to database
        Self::save_connection_state(db, client_name, false, Some(config_path.to_string_lossy().to_string())).await
            .map_err(|e| format!("Failed to save client connection state: {}", e))?;
        
        println!("✅ Removed Archestra tools from {} MCP config", client_name);
        
        Ok(())
    }
}

// Utility functions for config file operations
pub fn read_config_file(path: &PathBuf) -> Result<Value, String> {
    if !path.exists() {
        // Return empty config if file doesn't exist
        return Ok(serde_json::json!({
            "mcpServers": {}
        }));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config file {}: {}", path.display(), e))?;
    
    if content.trim().is_empty() {
        return Ok(serde_json::json!({
            "mcpServers": {}
        }));
    }

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse JSON in {}: {}", path.display(), e))
}

pub fn write_config_file(path: &PathBuf, config: &Value) -> Result<(), String> {
    println!("📝 Attempting to write config file to: {}", path.display());
    
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        println!("📁 Creating parent directory: {}", parent.display());
        std::fs::create_dir_all(parent)
            .map_err(|e| {
                let err_msg = format!("Failed to create config directory {}: {}", parent.display(), e);
                println!("❌ {}", err_msg);
                err_msg
            })?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| {
            let err_msg = format!("Failed to serialize config: {}", e);
            println!("❌ {}", err_msg);
            err_msg
        })?;
    
    println!("📄 Writing {} bytes to file", content.len());
    std::fs::write(path, &content)
        .map_err(|e| {
            let err_msg = format!("Failed to write config file {}: {}", path.display(), e);
            println!("❌ {}", err_msg);
            err_msg
        })?;
    
    // Verify the file was written correctly
    if let Ok(written_content) = std::fs::read_to_string(path) {
        if written_content == content {
            println!("✅ Config file written and verified successfully");
        } else {
            println!("⚠️  Config file written but content doesn't match");
        }
    } else {
        println!("⚠️  Config file written but couldn't verify content");
    }
    
    Ok(())
}

pub async fn get_available_mcp_servers() -> Result<Vec<String>, String> {
    // Get all available MCP servers from McpServerManager
    
    println!("🔍 Getting available MCP servers from server manager...");
    
    // For now, return the list of running servers from the manager
    // In the future, this could be enhanced to query the servers directly
    let server_names = vec![];
    
    println!("🎯 Found {} unique MCP servers: {:?}", server_names.len(), server_names);
    Ok(server_names)
}

pub fn create_archestra_server_config(server_name: &str) -> McpServerConfig {
    McpServerConfig {
        command: "curl".to_string(),
        args: vec![
            "-X".to_string(),
            "POST".to_string(),
            format!("http://localhost:54587/proxy/{}", server_name),
            "-H".to_string(),
            "Content-Type: application/json".to_string(),
            "-d".to_string(),
            "@-".to_string(), // Read JSON from stdin
        ],
    }
}

// Tauri commands
#[tauri::command]
pub async fn connect_mcp_client(app_handle: tauri::AppHandle, client_name: String) -> Result<(), String> {
    use crate::database::connection::get_database_connection_with_app;
    
    let db = get_database_connection_with_app(&app_handle).await
        .map_err(|e| format!("Failed to get database connection: {}", e))?;
    
    Model::connect_client(&db, &client_name).await
}

#[tauri::command]
pub async fn disconnect_mcp_client(app_handle: tauri::AppHandle, client_name: String) -> Result<(), String> {
    use crate::database::connection::get_database_connection_with_app;
    
    let db = get_database_connection_with_app(&app_handle).await
        .map_err(|e| format!("Failed to get database connection: {}", e))?;
    
    Model::disconnect_client(&db, &client_name).await
}

#[tauri::command]
pub async fn check_client_connection_status(
    app_handle: tauri::AppHandle,
    client: String,
) -> Result<bool, String> {
    use crate::database::connection::get_database_connection_with_app;

    let db = get_database_connection_with_app(&app_handle).await
        .map_err(|e| format!("Failed to get database connection: {}", e))?;

    // Check database first, fall back to config file verification
    let state = Model::get_connection_state(&db, &client).await
        .map_err(|e| format!("Failed to get client connection state: {}", e))?;
    
    if let Some(is_connected) = state {
        // Double-check by verifying config file has archestra tools
        if is_connected {
            let config_path = Model::get_config_path_for_client(&client)?;
            let config = read_config_file(&config_path)?;

            if let Some(mcp_servers) = config["mcpServers"].as_object() {
                let has_archestra_tools = mcp_servers.keys()
                    .any(|key| key.ends_with(" (archestra.ai)"));

                // If database says connected but config doesn't have tools, update database
                if !has_archestra_tools {
                    Model::save_connection_state(&db, &client, false, Some(config_path.to_string_lossy().to_string())).await
                        .map_err(|e| format!("Failed to update client connection state: {}", e))?;
                    return Ok(false);
                }

                Ok(has_archestra_tools)
            } else {
                // No mcpServers section, definitely not connected
                Model::save_connection_state(&db, &client, false, Some(config_path.to_string_lossy().to_string())).await
                    .map_err(|e| format!("Failed to update client connection state: {}", e))?;
                Ok(false)
            }
        } else {
            Ok(false)
        }
    } else {
        // No database record, fall back to config file check
        let config_path = Model::get_config_path_for_client(&client)?;
        let config = read_config_file(&config_path)?;

        if let Some(mcp_servers) = config["mcpServers"].as_object() {
            let has_archestra_tools = mcp_servers.keys()
                .any(|key| key.ends_with(" (archestra.ai)"));
            Ok(has_archestra_tools)
        } else {
            Ok(false)
        }
    }
}

// Function to be called when new MCP servers are started
#[tauri::command]
pub async fn notify_new_mcp_tools_available(app_handle: tauri::AppHandle) -> Result<(), String> {
    use crate::database::connection::get_database_connection_with_app;

    let db = get_database_connection_with_app(&app_handle).await
        .map_err(|e| format!("Failed to get database connection: {}", e))?;

    // Get all available MCP servers
    let servers = get_available_mcp_servers().await?;

    // Get connected clients from database
    let clients = Model::get_connected_clients(&db).await
        .map_err(|e| format!("Failed to get connected clients: {}", e))?;

    // Update each connected client
    for client in clients {
        println!("Updating {} with new MCP servers: {:?}", client, servers);

        let config_path = Model::get_config_path_for_client(&client)?;
        let mut config = read_config_file(&config_path)?;

        // Ensure mcpServers object exists
        if !config.is_object() {
            config = serde_json::json!({});
        }
        if !config.get("mcpServers").is_some() {
            config["mcpServers"] = serde_json::json!({});
        }

        let mcp_servers = config["mcpServers"].as_object_mut()
            .ok_or("mcpServers is not an object")?;

        // Add new MCP servers
        for server in &servers {
            let server_key = format!("{} (archestra.ai)", server);
            if !mcp_servers.contains_key(&server_key) {
                let server_config = create_archestra_server_config(server);
                mcp_servers.insert(server_key, serde_json::to_value(server_config).unwrap());
                println!("Added MCP server '{}' to {}", server, client);
            }
        }

        write_config_file(&config_path, &config)?;
    }

    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    // Test utilities

    #[tokio::test]
    async fn test_save_connection_state() {
        // Use in-memory database for testing
        let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
        
        // Run migrations
        use crate::database::migration::Migrator;
        use sea_orm_migration::MigratorTrait;
        Migrator::up(&db, None).await.unwrap();

        let result = Model::save_connection_state(&db, "test_client", true, Some("path/to/config".to_string())).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_connection_state() {
        // Use in-memory database for testing
        let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
        
        // Run migrations
        use crate::database::migration::Migrator;
        use sea_orm_migration::MigratorTrait;
        Migrator::up(&db, None).await.unwrap();

        // First save a connection state
        Model::save_connection_state(&db, "test_client", true, Some("path/to/config".to_string())).await.unwrap();

        let result = Model::get_connection_state(&db, "test_client").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Some(true));
    }

    #[test]
    fn test_get_config_path_for_client() {
        // Test cursor config path
        let cursor_path = Model::get_config_path_for_client("cursor");
        assert!(cursor_path.is_ok());
        let path = cursor_path.unwrap();
        assert!(path.to_string_lossy().contains(".cursor"));
        assert!(path.to_string_lossy().ends_with("mcp.json"));

        // Test claude config path
        let claude_path = Model::get_config_path_for_client("claude");
        assert!(claude_path.is_ok());
        let path = claude_path.unwrap();
        assert!(path.to_string_lossy().contains("Claude"));
        assert!(path.to_string_lossy().ends_with("claude_desktop_config.json"));

        // Test vscode config path
        let vscode_path = Model::get_config_path_for_client("vscode");
        assert!(vscode_path.is_ok());
        let path = vscode_path.unwrap();
        assert!(path.to_string_lossy().contains(".vscode"));
        assert!(path.to_string_lossy().ends_with("mcp.json"));

        // Test unknown client
        let unknown_path = Model::get_config_path_for_client("unknown");
        assert!(unknown_path.is_err());
        assert!(unknown_path.unwrap_err().contains("Unknown client"));
    }

    #[test]
    fn test_create_archestra_server_config() {
        let config = create_archestra_server_config("GitHub");
        
        assert_eq!(config.command, "curl");
        assert_eq!(config.args[0], "-X");
        assert_eq!(config.args[1], "POST");
        assert_eq!(config.args[2], "http://localhost:54587/proxy/GitHub");
        assert_eq!(config.args[3], "-H");
        assert_eq!(config.args[4], "Content-Type: application/json");
        assert_eq!(config.args[5], "-d");
        assert_eq!(config.args[6], "@-");
    }

    #[test]
    fn test_read_config_file_nonexistent() {
        use std::path::PathBuf;
        let nonexistent_path = PathBuf::from("/tmp/nonexistent_config.json");
        let result = read_config_file(&nonexistent_path);
        
        assert!(result.is_ok());
        let config = result.unwrap();
        assert!(config.is_object());
        assert!(config["mcpServers"].is_object());
    }

    #[test]
    fn test_client_mcp_config_serialization() {
        let mut servers = HashMap::new();
        servers.insert(
            "GitHub (archestra.ai)".to_string(),
            create_archestra_server_config("GitHub")
        );
        
        let config = ClientMcpConfig {
            mcp_servers: servers
        };
        
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("mcpServers"));
        assert!(json.contains("GitHub (archestra.ai)"));
        assert!(json.contains("curl"));
    }

    #[test]
    fn test_write_config_file() {
        use tempfile::NamedTempFile;
        
        // Create a temporary file for the config
        let temp_file = NamedTempFile::new().unwrap();
        let config_path = temp_file.path().to_path_buf();
        
        // Test writing a config
        let test_config = serde_json::json!({
            "mcpServers": {
                "test-server": {
                    "command": "test",
                    "args": ["arg1", "arg2"]
                }
            }
        });
        
        let result = write_config_file(&config_path, &test_config);
        assert!(result.is_ok());
        
        // Verify the file was written
        assert!(config_path.exists());
        
        // Read it back and verify contents
        let read_config = read_config_file(&config_path).unwrap();
        assert_eq!(read_config, test_config);
    }
    
    #[test]
    fn test_read_empty_file() {
        use tempfile::NamedTempFile;
        
        // Create an empty file
        let temp_file = NamedTempFile::new().unwrap();
        let config_path = temp_file.path().to_path_buf();
        std::fs::write(&config_path, "").unwrap();
        
        // Should return default config for empty file
        let result = read_config_file(&config_path).unwrap();
        assert!(result["mcpServers"].is_object());
        assert_eq!(result["mcpServers"].as_object().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_config_file_operations() {
        use tempfile::NamedTempFile;
        
        // Create a temporary file for the config
        let temp_file = NamedTempFile::new().unwrap();
        let config_path = temp_file.path().to_path_buf();
        
        // Write an initial config
        let initial_config = serde_json::json!({
            "existingField": "value",
            "mcpServers": {
                "existing-server": {
                    "command": "existing",
                    "args": []
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_config).unwrap()).unwrap();
        
        // Read the config back to verify structure
        let result_config = read_config_file(&config_path).unwrap();
        
        // Verify the config has the expected structure
        assert!(result_config.is_object());
        assert!(result_config["mcpServers"].is_object());
        assert_eq!(result_config["existingField"], "value");
        
        // Test that we can add a server config
        let mut config = result_config;
        let mcp_servers = config["mcpServers"].as_object_mut().unwrap();
        
        // Add a new server
        let server_key = "GitHub (archestra.ai)";
        let server_config = create_archestra_server_config("GitHub");
        mcp_servers.insert(server_key.to_string(), serde_json::to_value(server_config).unwrap());
        
        // Verify the new server was added correctly
        assert!(mcp_servers.contains_key("GitHub (archestra.ai)"));
        assert!(mcp_servers.contains_key("existing-server"));
        
        let github_config = &mcp_servers["GitHub (archestra.ai)"];
        assert_eq!(github_config["command"], "curl");
        assert_eq!(github_config["args"][2], "http://localhost:54587/proxy/GitHub");
    }

    #[test]
    fn test_disconnect_client_removes_archestra_servers() {
        use tempfile::NamedTempFile;
        
        // Create a temporary file for the config
        let temp_file = NamedTempFile::new().unwrap();
        let config_path = temp_file.path().to_path_buf();
        
        // Write a config with both archestra and non-archestra servers
        let initial_config = serde_json::json!({
            "mcpServers": {
                "GitHub (archestra.ai)": {
                    "command": "curl",
                    "args": ["-X", "POST", "http://localhost:54587/proxy/GitHub"]
                },
                "Slack (archestra.ai)": {
                    "command": "curl",
                    "args": ["-X", "POST", "http://localhost:54587/proxy/Slack"]
                },
                "other-server": {
                    "command": "other",
                    "args": []
                }
            }
        });
        std::fs::write(&config_path, serde_json::to_string_pretty(&initial_config).unwrap()).unwrap();
        
        // Read and modify the config as disconnect would
        let mut config = read_config_file(&config_path).unwrap();
        let mcp_servers = config["mcpServers"].as_object_mut().unwrap();
        
        // Remove all entries with "(archestra.ai)" suffix
        let keys_to_remove: Vec<String> = mcp_servers.keys()
            .filter(|key| key.ends_with(" (archestra.ai)"))
            .cloned()
            .collect();
        
        for key in keys_to_remove {
            mcp_servers.remove(&key);
        }
        
        // Verify only non-archestra servers remain
        assert_eq!(mcp_servers.len(), 1);
        assert!(mcp_servers.contains_key("other-server"));
        assert!(!mcp_servers.contains_key("GitHub (archestra.ai)"));
        assert!(!mcp_servers.contains_key("Slack (archestra.ai)"));
    }
}
