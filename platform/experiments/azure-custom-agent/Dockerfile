FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY azure_agent_with_archestra.py .

# Run the agent
CMD ["python", "azure_agent_with_archestra.py"]
