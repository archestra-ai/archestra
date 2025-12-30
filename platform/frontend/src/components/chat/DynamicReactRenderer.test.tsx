import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderComponentTree } from './DynamicReactRenderer';

// Mock UI components to simplify testing and focus on DynamicReactRenderer's logic
vi.mock('../ui/card', () => ({
  Card: vi.fn(({ children, ...props }) => <div data-testid="Card" {...props}>{children}</div>),
  CardContent: vi.fn(({ children, ...props }) => <div data-testid="CardContent" {...props}>{children}</div>),
  CardDescription: vi.fn(({ children, ...props }) => <div data-testid="CardDescription" {...props}>{children}</div>),
  CardFooter: vi.fn(({ children, ...props }) => <div data-testid="CardFooter" {...props}>{children}</div>),
  CardHeader: vi.fn(({ children, ...props }) => <div data-testid="CardHeader" {...props}>{children}</div>),
  CardTitle: vi.fn(({ children, ...props }) => <div data-testid="CardTitle" {...props}>{children}</div>),
}));

vi.mock('../ui/badge', () => ({
  Badge: vi.fn(({ children, ...props }) => <span data-testid="Badge" {...props}>{children}</span>),
}));

vi.mock('../ui/separator', () => ({
  Separator: vi.fn((props) => <hr data-testid="Separator" {...props} />),
}));

describe('renderComponentTree', () => {
  it('should render a single registered component with props', () => {
    const json = JSON.stringify({
      component: 'Card',
      props: {
        className: 'test-class',
        children: 'Hello Card',
      },
    });

    render(renderComponentTree(json));

    const card = screen.getByTestId('Card');
    expect(card).toBeInTheDocument();
    expect(card).toHaveClass('test-class');
    expect(card).toHaveTextContent('Hello Card');
  });

  it('should render nested registered components', () => {
    const json = JSON.stringify({
      component: 'Card',
      props: {
        children: [
          { component: 'CardHeader', props: { children: 'Header' } },
          { component: 'CardContent', props: { children: 'Content' } },
        ],
      },
    });

    render(renderComponentTree(json));

    const card = screen.getByTestId('Card');
    expect(card).toBeInTheDocument();

    const cardHeader = screen.getByTestId('CardHeader');
    expect(cardHeader).toBeInTheDocument();
    expect(cardHeader).toHaveTextContent('Header');

    const cardContent = screen.getByTestId('CardContent');
    expect(cardContent).toBeInTheDocument();
    expect(cardContent).toHaveTextContent('Content');
  });

  it('should render common HTML elements with children', () => {
    const json = JSON.stringify({
      component: 'div',
      props: {
        className: 'my-div',
        children: [
          { component: 'p', props: { children: 'Paragraph 1' } },
          { component: 'span', props: { children: 'Span 1' } },
          { component: 'h2', props: { children: 'Title 1' } },
        ],
      },
    });

    render(renderComponentTree(json));

    // We no longer query by role 'generic' directly on the div because it's ambiguous.
    // Instead, we check for the children content and the parent's class.
    const divElement = screen.getByText('Paragraph 1').closest('div'); // Find a div that contains the paragraph
    expect(divElement).toBeInTheDocument();
    expect(divElement).toHaveClass('my-div');

    expect(screen.getByText('Paragraph 1')).toBeInTheDocument();
    expect(screen.getByText('Span 1')).toBeInTheDocument();
    expect(screen.getByText('Title 1')).toBeInTheDocument();
  });

  it('should handle arrays of primitive children within an element', () => {
    const json = JSON.stringify({
      component: 'ul',
      props: {
        className: 'my-list',
        children: [
          { component: 'li', props: { children: 'Item 1' } },
          { component: 'li', props: { children: 'Item 2' } },
        ],
      },
    });

    render(renderComponentTree(json));

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    const ulElement = screen.getByRole('list');
    expect(ulElement).toBeInTheDocument();
    expect(ulElement).toHaveClass('my-list');
  });

  it('should display an error for an unregistered component', () => {
    const json = JSON.stringify({
      component: 'NonExistentComponent',
      props: {},
    });

    render(renderComponentTree(json));
    // Updated assertion to match the new error message from renderComponentTree
    expect(screen.getByText(/Error: Component 'NonExistentComponent' not found/i)).toBeInTheDocument();
  });

  it('should display an error for invalid JSON', () => {
    const invalidJson = '{ component: "Card", props: { children: "Missing quote }';

    render(renderComponentTree(invalidJson));
    // Updated assertion to match the new error message from renderComponentTree
    expect(screen.getByText(/Error: Failed to load component/i)).toBeInTheDocument();
  });

  it('should correctly render nested objects as JSON strings when passed as children', () => {
    const complexData = {
      annual: '$9,999',
      monthly: '$999',
    };

    const json = JSON.stringify({
      component: 'CardContent',
      props: {
        children: complexData, // Passed directly as a child to be stringified by renderPropValue
      }
    });

    render(renderComponentTree(json));
    const cardContent = screen.getByTestId('CardContent');
    expect(cardContent).toBeInTheDocument();
    // Expect the `complexData` object to be stringified and rendered as text content
    expect(cardContent.textContent?.replace(/\s/g, '')).toEqual(JSON.stringify(complexData, null, 2).replace(/\s/g, ''));
  });

  it('should handle arrays of strings as ul li structure within children', () => {
    const featuresList = ['Feature 1', 'Feature 2', 'Feature 3'];
    const json = JSON.stringify({
      component: 'Card',
      props: {
        children: [
          { component: 'ul', props: { children: featuresList.map(f => ({ component: 'li', props: { children: f }})) } }
        ]
      }
    });

    render(renderComponentTree(json));

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('Feature 1')).toBeInTheDocument();
    expect(screen.getByText('Feature 2')).toBeInTheDocument();
    expect(screen.getByText('Feature 3')).toBeInTheDocument();
  });
});
