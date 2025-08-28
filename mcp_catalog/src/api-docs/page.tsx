import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';

export default function ApiDocsPage() {
  return <SwaggerUI url="/mcp-catalog/api/docs" tryItOutEnabled={true} filter={true} />;
}
