allow_k8s_contexts(['orbstack', 'docker-desktop'])

load('ext://dotenv', 'dotenv')

is_prod = os.getenv('PROD') == 'true'

# Check if .env exists, if not copy from .env.example
if not os.path.exists('.env'):
  local('cp .env.example .env', command_bat='copy .env.example .env')
  print("📝 Created .env from .env.example, be sure to fill in any necessary unique values (ex. API keys)")
else:
  print("📝 .env already exists, skipping copy from .env.example")

# Load .env file FIRST, before any env var syncing
dotenv('./.env')

# Watch .env file for changes - triggers Tiltfile re-evaluation and restarts pnpm-dev
watch_file('.env')

# Load sub-Tiltfiles by label
load_dynamic('./dev/Tiltfile.database')
load_dynamic('./dev/Tiltfile.dev')
load_dynamic('./dev/Tiltfile.test')
load_dynamic('./dev/Tiltfile.integrations')
