/**
 * @vitest-environment jsdom
 *
 * Behaviour-level coverage for the UI primitives. These assert what a user (or
 * a screen reader) can actually observe — labels, roles, focus and side
 * effects — never internal class strings, which are free to change.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Badge } from './badge';
import { Button } from './button';
import { CopyButton } from './copy-button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Button', () => {
  it('renders its label and fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Analyze repository</Button>);

    const button = screen.getByRole('button', { name: 'Analyze repository' });
    expect(button).toBeInTheDocument();

    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Run</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('disables itself and reports aria-busy while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <Button loading onClick={onClick}>
        Analyzing
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Analyzing' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('marks an asChild target aria-disabled instead of disabled', () => {
    render(
      <Button asChild loading>
        <a href="/report">Open report</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Open report' });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).toHaveAttribute('aria-busy', 'true');
  });

  it('lets a consumer className override a variant default', () => {
    render(<Button className="bg-canvas">Override</Button>);
    const button = screen.getByRole('button', { name: 'Override' });
    const classes = button.className.split(/\s+/);
    expect(classes).toContain('bg-canvas');
    expect(classes).not.toContain('bg-jade');
  });
});

describe('Badge', () => {
  const variants = [
    'neutral',
    'jade',
    'good',
    'fair',
    'warn',
    'bad',
    'critical',
    'info',
    'outline',
  ] as const;

  it.each(variants)('renders the %s variant', (variant) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    expect(screen.getByText(variant)).toBeInTheDocument();
  });

  it('renders every variant with a distinct class signature', () => {
    const seen = new Set<string>();
    for (const variant of variants) {
      const { container, unmount } = render(<Badge variant={variant}>x</Badge>);
      const badge = container.firstElementChild;
      expect(badge).not.toBeNull();
      seen.add(badge?.className ?? '');
      unmount();
    }
    expect(seen.size).toBe(variants.length);
  });

  it('applies the uppercase treatment only when asked', () => {
    const { container: plain } = render(<Badge>plain</Badge>);
    const { container: shouty } = render(<Badge uppercase>shouty</Badge>);

    expect(plain.firstElementChild?.className).not.toContain('uppercase');
    expect(shouty.firstElementChild?.className).toContain('uppercase');
  });
});

describe('Tabs', () => {
  function Fixture() {
    return (
      <Tabs defaultValue="overview">
        <TabsList aria-label="Analysis sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="graph">Graph panel</TabsContent>
        <TabsContent value="security">Security panel</TabsContent>
      </Tabs>
    );
  }

  it('exposes a tablist with the correct roles and selection state', () => {
    render(<Fixture />);

    const tablist = screen.getByRole('tablist', { name: 'Analysis sections' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Overview panel');
  });

  it('switches panels with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    await user.tab();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Graph' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Graph panel');

    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel')).toHaveTextContent('Security panel');
    });

    // Radix wraps at the end of the list.
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel')).toHaveTextContent('Overview panel');
    });
  });

  it('switches panels on click and reports the change', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <Tabs defaultValue="a" onValueChange={onValueChange}>
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    );

    await user.click(screen.getByRole('tab', { name: 'B' }));
    expect(onValueChange).toHaveBeenCalledWith('b');
    await waitFor(() => {
      expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B');
    });
  });
});

describe('Dialog', () => {
  function Fixture() {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open settings</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Analysis settings</DialogTitle>
          <DialogDescription>Tune what GitBrain looks at.</DialogDescription>
          <Button>Save</Button>
        </DialogContent>
      </Dialog>
    );
  }

  it('opens, exposes an accessible name, and traps focus inside', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    const dialog = await screen.findByRole('dialog', { name: 'Analysis settings' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Tune what GitBrain looks at.')).toBeInTheDocument();

    // Focus starts inside and every tab stop stays inside.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await user.click(trigger);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('closes via the built-in close button', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('CopyButton', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  /**
   * `userEvent.setup()` installs its own `navigator.clipboard` stub, so ours has
   * to be attached afterwards or the component would talk to user-event's copy.
   */
  function installClipboard() {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  }

  it('writes the value to the clipboard and confirms', async () => {
    const user = userEvent.setup();
    installClipboard();
    const onCopied = vi.fn();

    render(<CopyButton value="git clone https://github.com/acme/api" onCopied={onCopied} />);

    const button = screen.getByRole('button', { name: 'Copy to clipboard' });
    await user.click(button);

    expect(writeText).toHaveBeenCalledWith('git clone https://github.com/acme/api');
    expect(onCopied).toHaveBeenCalledWith('git clone https://github.com/acme/api');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('is reachable and activatable by keyboard alone', async () => {
    const user = userEvent.setup();
    installClipboard();
    render(<CopyButton value="npm run verify" />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledWith('npm run verify');
  });

  /**
   * Real timers on purpose: user-event's pointer sequence and Vitest's mocked
   * clock deadlock each other, and the 2s window is short enough to just wait
   * out honestly.
   */
  it('reverts to the idle label after the confirmation window', async () => {
    const user = userEvent.setup();
    installClipboard();

    render(<CopyButton value="token" />);
    await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  }, 8000);

  it('stays in the idle state when the clipboard write is rejected', async () => {
    const user = userEvent.setup();
    installClipboard();
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    const onCopied = vi.fn();

    render(<CopyButton value="secret" onCopied={onCopied} />);
    await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });
});
