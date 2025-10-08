from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from dotenv import load_dotenv
import os
import sys
import argparse

# Load environment variables from .env file
load_dotenv()

# Track conversation history
conversation_history = []


def chat(user_message: str, use_archestra: bool = False):
  """Process a chat message through the agent."""
  conversation_history.append({"role": "user", "content": user_message})

  agent = Agent(
    model=OpenAIChatModel(
      model_name="gpt-4o",
      provider=OpenAIProvider(
        base_url="http://localhost:9000/v1" if use_archestra else "https://api.openai.com/v1",
        api_key=os.getenv("OPENAI_API_KEY"),
      ),
    ),
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
  # Parse command line arguments
  parser = argparse.ArgumentParser(description='CLI chat with optional Archestra security layer')
  parser.add_argument('--secure', action='store_true', help='Use Archestra Platform as security proxy')
  args = parser.parse_args()

  mode = "Archestra-secured" if args.secure else "direct OpenAI"
  print(f'CLI Chat started ({mode} mode). Type "exit" or "quit" to end the conversation.\n')

  while True:
    try:
      user_input = input("You: ").strip()

      if user_input.lower() in ["exit", "quit"]:
        print("Goodbye!")
        sys.exit(0)

      if not user_input:
        continue

      response = chat(user_input, use_archestra=args.secure)
      print(f"\nAssistant: {response}\n")
    except KeyboardInterrupt:
      print("\nGoodbye!")
      sys.exit(0)
    except Exception as e:
      print(f"\nError: {e}\n")


if __name__ == "__main__":
  main()
