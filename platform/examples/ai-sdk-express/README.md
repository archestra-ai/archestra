# Archestra + Express.js + AI SDK Example

An example used by Archestra's guide on how to integrate with Vercel AI / AI SDK: <https://www.archestra.ai/docs/platform-vercel-ai-example>.

It demonstrates how to use AI SDK in an [Express.js](https://expressjs.com/) server to generate and stream text and objects and connect Archestra as a security layer.

## Usage

1. Start the Archestra Platform:

    ```sh
    docker run -p 9000:9000 -p 3000:3000 archestra/platform
    ```

2. Create .env file with the following content:

    ```sh
    OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
    ```

3. Run the following commands from this directory:

    ```sh
    npm install
    ```

4. Run the following command:

    ```sh
    npm run dev
    ```

5. Chat with assistant through CLI and check that Archestra Platform handles the requests at <http://localhost:3000>
