from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIModel
from dotenv import load_dotenv
import os
import sys

# Load environment variables from .env file
load_dotenv()

# Track conversation history
conversation_history = []


def chat(user_message: str):
  """Process a chat message through the agent."""
  conversation_history.append({"role": "user", "content": user_message})

  # Configure OpenAI model to use Archestra as proxy
  model = OpenAIModel(
    "gpt-4o",
    base_url="http://localhost:9000/v1",  # Point requests to Archestra Platform
    api_key=os.getenv("OPENAI_API_KEY"),
  )

  # Create agent with custom model
  agent = Agent(
    model=model, instructions="Be helpful and concise. Answer user questions clearly."
  )

  @agent.tool
  def get_file(ctx: RunContext[None], file_path: str) -> dict:
    """Get the contents of a file."""
    try:
      with open(file_path, "r") as f:
        return {"content": f.read()}
    except FileNotFoundError:
      return {"error": f"File not found: {file_path}"}
    except Exception as e:
      return {"error": str(e)}

  # Run agent synchronously with conversation history
  result = agent.run_sync(user_message)

  # Add assistant response to history
  conversation_history.append({"role": "assistant", "content": result.output})

  return result.output


def main():
  """Main CLI loop."""
  print('CLI Chat started. Type "exit" or "quit" to end the conversation.\n')

  while True:
    try:
      user_input = input("You: ").strip()

      if user_input.lower() in ["exit", "quit"]:
        print("Goodbye!")
        sys.exit(0)

      if not user_input:
        continue

      response = chat(user_input)
      print(f"\nAssistant: {response}\n")
    except KeyboardInterrupt:
      print("\nGoodbye!")
      sys.exit(0)
    except Exception as e:
      print(f"\nError: {e}\n")


if __name__ == "__main__":
  main()
