# Archestra + Express.js + AI SDK Example

An example used by Archestra's guid on how to integrate with Vercel AI / AI SDK: https://www.archestra.ai/docs/platform-vercel-ai-example .

It demonstrates how to use AI SDK in an [Express.js](https://expressjs.com/) server to generate and stream text and objects and connect Archestra as a security layer.

## Usage

1. Create .env file with the following content (and more settings, depending on the providers you want to use):

```sh
OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
```

2. Run the following commands from the root directory of the AI SDK repo:

```sh
npm install
```

3. Run the following command:

```sh
npm run dev
```

4. Chat with assistant through CLI and check that Archestra Platform handles 
