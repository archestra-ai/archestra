/**
 * The `auto` model as a chat's model choice. It travels the setup menu's model
 * pool channel because, like a pool, it stands in for the key and model: the
 * server stores the normal tier as the chat's key and model and routes each
 * session to a fast, normal or smart model.
 */
export const AUTO_MODEL_CHOICE = "auto";
