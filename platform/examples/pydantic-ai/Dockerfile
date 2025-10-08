FROM python:3.11.3

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY .env .

# Set entrypoint to run the agent
ENTRYPOINT ["python", "main.py"]
