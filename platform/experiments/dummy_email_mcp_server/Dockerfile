FROM python:3.11-slim

# Install dependencies
RUN pip install mcp pydantic

# Copy the MCP server
COPY main.py /app/main.py
WORKDIR /app

# Make the script executable
RUN chmod +x main.py

# Run the MCP server
CMD ["python", "main.py"]