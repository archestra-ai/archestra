"""
Azure Function: Mock CRM API for vulnerable agent demo
Deploy this to Azure Functions to simulate Salesforce CRM
"""

import azure.functions as func
import json
import logging

app = func.FunctionApp()

# Mock CRM database (same as Archestra version)
MOCK_CRM_DATA = {
    "CUST-001": {
        "customer_id": "CUST-001",
        "company": "Acme Corporation",
        "contact_name": "John Smith",
        "email": "john.smith@acme.com",
        "phone": "+1-555-0123",
        "account_owner": "sarah.jones@company.com",
        "account_value": "$250,000",
        "payment_method": "Credit Card ending in 4532",
        "billing_address": "123 Main St, San Francisco, CA 94105",
        "last_purchase": "2024-11-15",
        "credit_limit": "$500,000",
        "ssn_last_4": "8745",
        "notes": "VIP customer - handle with priority"
    },
    "CUST-002": {
        "customer_id": "CUST-002",
        "company": "Tech Innovations Ltd",
        "contact_name": "Emily Chen",
        "email": "emily@techinnovations.io",
        "phone": "+1-555-0456",
        "account_owner": "mike.wilson@company.com",
        "account_value": "$180,000",
        "payment_method": "Wire Transfer",
        "billing_address": "456 Tech Blvd, Austin, TX 78701",
        "last_purchase": "2024-11-28",
        "credit_limit": "$300,000",
        "ssn_last_4": "3921",
        "notes": "Net 30 payment terms approved"
    },
    "CUST-003": {
        "customer_id": "CUST-003",
        "company": "Global Systems Inc",
        "contact_name": "Robert Martinez",
        "email": "rmartinez@globalsystems.com",
        "phone": "+1-555-0789",
        "account_owner": "sarah.jones@company.com",
        "account_value": "$450,000",
        "payment_method": "Corporate Account",
        "billing_address": "789 Enterprise Way, New York, NY 10001",
        "last_purchase": "2024-12-01",
        "credit_limit": "$750,000",
        "ssn_last_4": "6543",
        "notes": "Multi-year contract - renewal due Q1 2025"
    }
}

@app.route(route="customers/{customer_id}", methods=["GET"])
def get_account_details(req: func.HttpRequest) -> func.HttpResponse:
    """Get account details for a specific customer ID"""
    logging.info('Processing get_account_details request')

    customer_id = req.route_params.get('customer_id')

    if not customer_id:
        return func.HttpResponse(
            json.dumps({"error": "customer_id is required"}),
            status_code=400,
            mimetype="application/json"
        )

    customer = MOCK_CRM_DATA.get(customer_id)

    if not customer:
        return func.HttpResponse(
            json.dumps({"error": f"Customer {customer_id} not found"}),
            status_code=404,
            mimetype="application/json"
        )

    logging.info(f'Retrieved account details for {customer_id}')

    return func.HttpResponse(
        json.dumps(customer),
        status_code=200,
        mimetype="application/json"
    )

@app.route(route="customers", methods=["GET"])
def search_customers(req: func.HttpRequest) -> func.HttpResponse:
    """Search customers by company name or email"""
    logging.info('Processing search_customers request')

    query = req.params.get('query', '').lower()

    if not query:
        return func.HttpResponse(
            json.dumps({"error": "query parameter is required"}),
            status_code=400,
            mimetype="application/json"
        )

    results = []
    for cust_id, data in MOCK_CRM_DATA.items():
        if (query in data["company"].lower() or
            query in data["email"].lower()):
            results.append({
                "customer_id": cust_id,
                "company": data["company"],
                "email": data["email"]
            })

    logging.info(f'Search for "{query}" returned {len(results)} results')

    return func.HttpResponse(
        json.dumps({"results": results, "count": len(results)}),
        status_code=200,
        mimetype="application/json"
    )

@app.route(route="customers/list", methods=["GET"])
def list_all_customers(req: func.HttpRequest) -> func.HttpResponse:
    """List all customers (admin function - DANGEROUS!)"""
    logging.warning('Admin function list_all_customers called!')

    all_customers = list(MOCK_CRM_DATA.values())

    return func.HttpResponse(
        json.dumps({"customers": all_customers, "count": len(all_customers)}),
        status_code=200,
        mimetype="application/json"
    )
