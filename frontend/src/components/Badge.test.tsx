import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriorityBadge, SlaBadge, StatusBadge } from './Badge';

/**
 * Badges are the visual vocabulary of every queue and analytics chart, so the contract label
 * mapping is pinned here: a renamed status must fail this test rather than render `undefined`.
 */
describe('badges', () => {
  it('humanizes lifecycle statuses', () => {
    render(<StatusBadge status="in_progress" />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('labels priorities explicitly', () => {
    render(<PriorityBadge priority="critical" />);
    expect(screen.getByText('Critical priority')).toBeInTheDocument();
  });

  it('shows remaining business time when the tracker provides it', () => {
    render(<SlaBadge state="warning" remainingMinutes={42} />);
    expect(screen.getByText('Warning · 42 min left')).toBeInTheDocument();
  });

  it('falls back to a plain state label when no due date is set', () => {
    render(<SlaBadge state="breached" remainingMinutes={null} />);
    expect(screen.getByText('SLA breached')).toBeInTheDocument();
  });

  it('applies a token-based class so colour never drifts from the palette', () => {
    const { container } = render(<StatusBadge status="on_hold" />);
    expect(container.querySelector('span')).toHaveClass('text-status-on-hold');
  });
});
