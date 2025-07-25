use chrono::{DateTime, Utc};
use sea_orm::entity::prelude::*;
use sea_orm::{ActiveModelTrait, QueryOrder, Set};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize, ToSchema)]
#[sea_orm(table_name = "messages")]
#[schema(as = Message)]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub chat_id: i32,
    pub role: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "crate::models::chat::Entity",
        from = "Column::ChatId",
        to = "crate::models::chat::Column::Id"
    )]
    Chat,
}

impl Related<crate::models::chat::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Chat.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MessageDefinition {
    pub chat_id: i32,
    pub role: String,
    pub content: String,
}

impl Model {
    pub async fn save(
        definition: MessageDefinition,
        db: &DatabaseConnection,
    ) -> Result<Model, DbErr> {
        let new_message = ActiveModel {
            chat_id: Set(definition.chat_id),
            role: Set(definition.role),
            content: Set(definition.content),
            created_at: Set(Utc::now()),
            ..Default::default()
        };

        new_message.insert(db).await
    }

    pub async fn load_by_chat(chat_id: i32, db: &DatabaseConnection) -> Result<Vec<Model>, DbErr> {
        Entity::find()
            .filter(Column::ChatId.eq(chat_id))
            .order_by_asc(Column::CreatedAt)
            .all(db)
            .await
    }

    pub async fn delete_by_chat(chat_id: i32, db: &DatabaseConnection) -> Result<u64, DbErr> {
        Entity::delete_many()
            .filter(Column::ChatId.eq(chat_id))
            .exec(db)
            .await
            .map(|res| res.rows_affected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::chat::{ChatDefinition, Model as ChatModel};
    use crate::test_fixtures::database;
    use rstest::rstest;

    #[rstest]
    #[tokio::test]
    async fn test_message_crud(#[future] database: DatabaseConnection) {
        let db = database.await;

        let chat_def = ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };
        let chat = ChatModel::save(chat_def, &db).await.unwrap();

        let message_def = MessageDefinition {
            chat_id: chat.id,
            role: "user".to_string(),
            content: "Hello, world!".to_string(),
        };

        let message = Model::save(message_def, &db).await.unwrap();
        assert_eq!(message.chat_id, chat.id);
        assert_eq!(message.role, "user");
        assert_eq!(message.content, "Hello, world!");

        let messages = Model::load_by_chat(chat.id, &db).await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, message.id);
    }

    #[rstest]
    #[tokio::test]
    async fn test_multiple_messages(#[future] database: DatabaseConnection) {
        let db = database.await;

        let chat_def = ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };
        let chat = ChatModel::save(chat_def, &db).await.unwrap();

        let messages = vec![
            MessageDefinition {
                chat_id: chat.id,
                role: "user".to_string(),
                content: "Hello".to_string(),
            },
            MessageDefinition {
                chat_id: chat.id,
                role: "assistant".to_string(),
                content: "Hi there!".to_string(),
            },
            MessageDefinition {
                chat_id: chat.id,
                role: "user".to_string(),
                content: "How are you?".to_string(),
            },
        ];

        for msg_def in messages {
            Model::save(msg_def, &db).await.unwrap();
        }

        let loaded_messages = Model::load_by_chat(chat.id, &db).await.unwrap();
        assert_eq!(loaded_messages.len(), 3);
        assert_eq!(loaded_messages[0].role, "user");
        assert_eq!(loaded_messages[1].role, "assistant");
        assert_eq!(loaded_messages[2].role, "user");
    }

    #[rstest]
    #[tokio::test]
    async fn test_delete_by_chat(#[future] database: DatabaseConnection) {
        let db = database.await;

        let chat_def = ChatDefinition {
            llm_provider: "ollama".to_string(),
            llm_model: "llama3.2".to_string(),
        };
        let chat = ChatModel::save(chat_def, &db).await.unwrap();

        let message_def = MessageDefinition {
            chat_id: chat.id,
            role: "user".to_string(),
            content: "Test message".to_string(),
        };
        Model::save(message_def.clone(), &db).await.unwrap();
        Model::save(message_def, &db).await.unwrap();

        let deleted = Model::delete_by_chat(chat.id, &db).await.unwrap();
        assert_eq!(deleted, 2);

        let messages = Model::load_by_chat(chat.id, &db).await.unwrap();
        assert_eq!(messages.len(), 0);
    }
}
