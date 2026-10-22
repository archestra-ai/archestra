"""Real Python SDK contract fixture. Inputs and credentials are disposable test data."""
import base64
import json
import os
import sys

import openai

origin, provider, agent_id, operation = sys.argv[1:]
audio = base64.b64decode(os.environ["ARCHESTRA_AUDIO_FIXTURE_BYTES"])
key = os.environ["ARCHESTRA_AUDIO_FIXTURE_KEY"]
requests = 0
for with_agent in (False, True):
    endpoint = f"{origin}/v1/{provider}" + (f"/{agent_id}" if with_agent else "")
    kinds = ("openai", "azure") if provider == "azure" else ("openai",)
    for kind in kinds:
        if kind == "azure":
            client = openai.AzureOpenAI(azure_deployment="tts-alias" if operation == "speech" else "transcribe-alias", azure_endpoint=endpoint, api_version="2025-04-01-preview", api_key=key, max_retries=0)
        else:
            client = openai.OpenAI(base_url=endpoint, api_key=key, max_retries=0)
        with client:
            if operation == "speech":
                with client.audio.speech.with_streaming_response.create(model="spoofed-body-model" if kind == "azure" else "tts-alias", input="Synthetic audio.", voice="alloy", response_format="wav") as response:
                    assert response.headers["content-type"].startswith("audio/wav")
                    assert b"".join(response.iter_bytes()) == audio
            else:
                result = getattr(client.audio, operation).create(model="spoofed-body-model" if kind == "azure" else "transcribe-alias", file=("synthetic.wav", audio, "audio/wav"))
                assert result.text == "Synthetic audio."
            requests += 1
print(json.dumps({"sdk": openai.__version__, "requests": requests, "operation": operation}))
