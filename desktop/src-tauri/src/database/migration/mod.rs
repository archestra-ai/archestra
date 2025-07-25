use sea_orm_migration::prelude::*;

mod m20240101_000001_create_mcp_servers_table;
mod m20240101_000002_create_external_mcp_clients_table;
mod m20240101_000003_create_mcp_request_logs_table;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_create_mcp_servers_table::Migration),
            Box::new(m20240101_000002_create_external_mcp_clients_table::Migration),
            Box::new(m20240101_000003_create_mcp_request_logs_table::Migration),
        ]
    }
}
