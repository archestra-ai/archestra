use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Chats::Table)
                    .if_not_exists()
                    .col(pk_auto(Chats::Id))
                    .col(string(Chats::Title))
                    .col(string(Chats::LlmProvider))
                    .col(string(Chats::LlmModel))
                    .col(timestamp_with_time_zone(Chats::CreatedAt))
                    .col(timestamp_with_time_zone(Chats::UpdatedAt))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Chats::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Chats {
    Table,
    Id,
    Title,
    LlmProvider,
    LlmModel,
    CreatedAt,
    UpdatedAt,
}
