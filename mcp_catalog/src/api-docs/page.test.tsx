import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import Page from './page';

// Mock the swagger-ui-react component
vi.mock('swagger-ui-react', () => ({
  default: ({ url }: { url: string }) => (
    <div data-testid="swagger-ui" data-url={url}>
      SwaggerUI Component
    </div>
  ),
}));

// Mock the CSS import
vi.mock('swagger-ui-react/swagger-ui.css', () => ({}));

describe('/mcp-catalog/api-docs page', () => {
  it('should render successfully', () => {
    render(<Page />);

    // Check that SwaggerUI is rendered
    const swaggerUI = screen.getByTestId('swagger-ui');
    expect(swaggerUI).toBeInTheDocument();
  });

  it('should load the correct OpenAPI spec URL', () => {
    render(<Page />);

    const swaggerUI = screen.getByTestId('swagger-ui');
    expect(swaggerUI).toHaveAttribute('data-url', '/mcp-catalog/api/docs');
  });
});
