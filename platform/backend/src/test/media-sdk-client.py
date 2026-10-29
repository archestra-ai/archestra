import json
import os
import base64
from openai import OpenAI, AzureOpenAI, APIStatusError

client = AzureOpenAI(
    azure_endpoint=os.environ["MEDIA_SDK_BASE_URL"],
    api_key=os.environ["MEDIA_SDK_API_KEY"],
    api_version="2025-04-01-preview",
    azure_deployment="gpt-image-1",
    max_retries=0,
    timeout=10,
) if os.environ.get("MEDIA_SDK_AZURE") else OpenAI(
    base_url=os.environ["MEDIA_SDK_BASE_URL"],
    api_key=os.environ["MEDIA_SDK_API_KEY"],
    max_retries=0,
    timeout=10,
)
stage = "create"
try:
    with open(os.environ["MEDIA_SDK_IMAGE"], "rb") as first, open(
        os.environ["MEDIA_SDK_IMAGE"], "rb"
    ) as second, open(os.environ["MEDIA_SDK_IMAGE"], "rb") as mask:
        if os.environ.get("MEDIA_SDK_OPERATION") == "files":
            uploaded = client.files.create(file=first, purpose="user_data")
            stage = "retrieve"
            retrieved = client.files.retrieve(uploaded.id)
            stage = "list"
            listed = client.files.list(limit=1)
            stage = "content"
            content = client.files.content(uploaded.id).read()
            stage = "delete"
            deleted = client.files.delete(uploaded.id)
            result = {"file": uploaded.model_dump(), "retrieved": retrieved.model_dump(), "listed": [file.model_dump() for file in listed.data], "content": base64.b64encode(content).decode(), "deleted": deleted.model_dump()}
        else:
            result = client.images.edit(
                model="gpt-image-1",
                prompt="Add a small blue circle.",
                image=[first, second],
                mask=mask,
                n=1,
                stream=False,
            )
    print(json.dumps({"status": 200, "response": result if isinstance(result, dict) else result.model_dump()}))
except APIStatusError as error:
    print(json.dumps({"status": error.status_code, "type": type(error).__name__, "stage": stage, "body": error.body}))
