use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use sea_orm::{ActiveModelTrait, ConnectionTrait, DatabaseBackend, QueryOrder, Set, Statement};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize, ToSchema)]
#[sea_orm(table_name = "chats")]
#[schema(as = Chat)]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub title: String,
    pub llm_provider: String,
    pub llm_model: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "crate::models::message::Entity")]
    Messages,
}

impl Related<crate::models::message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Messages.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ChatDefinition {
    pub llm_provider: String,
    pub llm_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ChatWithMessages {
    pub chat: Model,
    pub messages: Vec<crate::models::message::Model>,
}

impl Model {
    pub async fn save(definition: ChatDefinition, db: &DatabaseConnection) -> Result<Model, DbErr> {
        let now = Utc::now();
        let new_chat = ActiveModel {
            title: Set("New Chat".to_string()),
            llm_provider: Set(definition.llm_provider),
            llm_model: Set(definition.llm_model),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };

        new_chat.insert(db).await
    }

    pub async fn load(id: i32, db: &DatabaseConnection) -> Result<Option<Model>, DbErr> {
        Entity::find_by_id(id).one(db).await
    }

    pub async fn load_with_messages(
        id: i32,
        db: &DatabaseConnection,
    ) -> Result<Option<ChatWithMessages>, DbErr> {
        let chat = Entity::find_by_id(id).one(db).await?;

        match chat {
            Some(chat) => {
                let messages = chat
                    .find_related(crate::models::message::Entity)
                    .order_by_asc(crate::models::message::Column::CreatedAt)
                    .all(db)
                    .await?;

                Ok(Some(ChatWithMessages { chat, messages }))
            }
            None => Ok(None),
        }
    }

    pub async fn load_all(db: &DatabaseConnection) -> Result<Vec<Model>, DbErr> {
        Entity::find()
            .order_by_desc(Column::UpdatedAt)
            .all(db)
            .await
    }

    pub async fn update_title(
        id: i32,
        title: String,
        db: &DatabaseConnection,
    ) -> Result<Model, DbErr> {
        let mut chat: ActiveModel = Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("Chat not found".to_string()))?
            .into();

        chat.title = Set(title);
        chat.updated_at = Set(Utc::now());
        chat.update(db).await
    }

    pub async fn delete(id: i32, db: &DatabaseConnection) -> Result<(), DbErr> {
        Entity::delete_by_id(id).exec(db).await?;
        Ok(())
    }

    pub async fn count_messages(id: i32, db: &DatabaseConnection) -> Result<u64, DbErr> {
        let result = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "SELECT COUNT(*) as count FROM messages WHERE chat_id = ?",
                vec![id.into()],
            ))
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("Chat not found".to_string()))?;

        result.try_get_by_index::<i64>(0).map(|count| count as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::database;
    use rstest::rstest;

    #[rstest]
    #[tokio::test]
    async fn test_chat_crud(#[future] database: DatabaseConnection) {
        let db = database.await;

        let definition = ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };

        let chat = Model::save(definition, &db).await.unwrap();
        assert_eq!(chat.title, "New Chat");
        assert_eq!(chat.llm_provider, "ollama");
        assert_eq!(chat.llm_model, "llama3.2");

        let loaded = Model::load(chat.id, &db).await.unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().id, chat.id);

        let all_chats = Model::load_all(&db).await.unwrap();
        assert_eq!(all_chats.len(), 1);

        let updated = Model::update_title(chat.id, "Updated Title".to_string(), &db)
            .await
            .unwrap();
        assert_eq!(updated.title, "Updated Title");

        Model::delete(chat.id, &db).await.unwrap();
        let deleted = Model::load(chat.id, &db).await.unwrap();
        assert!(deleted.is_none());
    }

    #[rstest]
    #[tokio::test]
    async fn test_load_with_messages(#[future] database: DatabaseConnection) {
        let db = database.await;

        let chat_def = ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };
        let chat = Model::save(chat_def, &db).await.unwrap();

        let message_def1 = crate::models::message::MessageDefinition {
            chat_id: chat.id,
            role: "user".to_string(),
            content: "Hello".to_string(),
        };
        let message_def2 = crate::models::message::MessageDefinition {
            chat_id: chat.id,
            role: "assistant".to_string(),
            content: "Hi there!".to_string(),
        };

        crate::models::message::Model::save(message_def1, &db)
            .await
            .unwrap();
        crate::models::message::Model::save(message_def2, &db)
            .await
            .unwrap();

        let chat_with_messages = Model::load_with_messages(chat.id, &db)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(chat_with_messages.chat.id, chat.id);
        assert_eq!(chat_with_messages.messages.len(), 2);
        assert_eq!(chat_with_messages.messages[0].role, "user");
        assert_eq!(chat_with_messages.messages[1].role, "assistant");
    }

    #[rstest]
    #[tokio::test]
    async fn test_count_messages(#[future] database: DatabaseConnection) {
        let db = database.await;

        let chat_def = ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };
        let chat = Model::save(chat_def, &db).await.unwrap();

        let count = Model::count_messages(chat.id, &db).await.unwrap();
        assert_eq!(count, 0);

        let message_def = crate::models::message::MessageDefinition {
            chat_id: chat.id,
            role: "user".to_string(),
            content: "Test".to_string(),
        };
        crate::models::message::Model::save(message_def, &db)
            .await
            .unwrap();

        let count = Model::count_messages(chat.id, &db).await.unwrap();
        assert_eq!(count, 1);
    }
}
