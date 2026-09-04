/**
 * Unit Tests for StateCalculator
 *
 * These tests are written against the API StateCalculator actually exposes:
 *   determineConversationState, determineConversationStatus,
 *   detectRealClaudeActivity, quickStateCalculation, getStateClass, clearCache
 *
 * All times are built relative to Date.now() so the suite is deterministic
 * regardless of when it runs.
 */

const StateCalculator = require('../../src/analytics/core/StateCalculator');

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const secondsAgo = (n) => new Date(Date.now() - n * 1000);
const msg = (role, mins, extra = {}) => ({
  role,
  timestamp: minutesAgo(mins).toISOString(),
  ...extra,
});

describe('StateCalculator', () => {
  let stateCalculator;

  beforeEach(() => {
    stateCalculator = new StateCalculator();
  });

  describe('constructor', () => {
    it('initialises an empty process cache', () => {
      expect(stateCalculator.processCache).toBeInstanceOf(Map);
      expect(stateCalculator.processCache.size).toBe(0);
    });
  });

  describe('determineConversationState', () => {
    it('reports Claude working when the file was just modified', () => {
      // File touched within the last minute is the strongest activity signal.
      const state = stateCalculator.determineConversationState([], secondsAgo(10));
      expect(state).toBe('Claude Code working...');
    });

    it('returns Idle for an empty conversation with an old file', () => {
      const state = stateCalculator.determineConversationState([], minutesAgo(90));
      expect(state).toBe('Idle');
    });

    it('returns "User typing..." when the user spoke last, 20 minutes ago', () => {
      const state = stateCalculator.determineConversationState(
        [msg('user', 20)],
        minutesAgo(90)
      );
      expect(state).toBe('User typing...');
    });

    it('returns "Recently active" when the user spoke last, over 30 minutes ago', () => {
      const state = stateCalculator.determineConversationState(
        [msg('user', 45)],
        minutesAgo(90)
      );
      expect(state).toBe('Recently active');
    });

    it('returns "Recently active" when the assistant spoke last, over 30 minutes ago', () => {
      const state = stateCalculator.determineConversationState(
        [msg('assistant', 45)],
        minutesAgo(90)
      );
      expect(state).toBe('Recently active');
    });

    it('uses the newest message regardless of input order', () => {
      const outOfOrder = [msg('assistant', 45), msg('user', 20)];
      const state = stateCalculator.determineConversationState(outOfOrder, minutesAgo(90));
      // Newest is the 20-minute-old user message.
      expect(state).toBe('User typing...');
    });

    it('reports an active session for a running process on a cold conversation', () => {
      const state = stateCalculator.determineConversationState(
        [msg('user', 60)],
        minutesAgo(90),
        { hasActiveCommand: true }
      );
      expect(state).toBe('Active session');
    });

    it('ignores a process that has no active command', () => {
      const state = stateCalculator.determineConversationState(
        [msg('user', 45)],
        minutesAgo(90),
        { hasActiveCommand: false }
      );
      expect(state).toBe('Recently active');
    });
  });

  describe('determineConversationStatus', () => {
    it('is active for an empty conversation with a fresh file', () => {
      expect(stateCalculator.determineConversationStatus([], minutesAgo(1))).toBe('active');
    });

    it('is inactive for an empty conversation with an old file', () => {
      expect(stateCalculator.determineConversationStatus([], minutesAgo(90))).toBe('inactive');
    });

    it('is active when the user spoke within 3 minutes', () => {
      expect(
        stateCalculator.determineConversationStatus([msg('user', 1)], minutesAgo(90))
      ).toBe('active');
    });

    it('is active when the assistant spoke within 5 minutes', () => {
      expect(
        stateCalculator.determineConversationStatus([msg('assistant', 2)], minutesAgo(90))
      ).toBe('active');
    });

    it('falls back to recent based on file time', () => {
      expect(
        stateCalculator.determineConversationStatus([msg('user', 60)], minutesAgo(10))
      ).toBe('recent');
    });

    it('is inactive once both message and file are cold', () => {
      expect(
        stateCalculator.determineConversationStatus([msg('user', 120)], minutesAgo(90))
      ).toBe('inactive');
    });
  });

  describe('detectRealClaudeActivity', () => {
    it('reports "No messages" for an empty conversation', () => {
      const result = stateCalculator.detectRealClaudeActivity([], minutesAgo(30));
      expect(result).toEqual({ isActive: false, status: 'No messages' });
    });

    it('handles a null message list without throwing', () => {
      const result = stateCalculator.detectRealClaudeActivity(null, minutesAgo(30));
      expect(result).toEqual({ isActive: false, status: 'No messages' });
    });

    it('is active when the file changed less than a minute ago', () => {
      const result = stateCalculator.detectRealClaudeActivity([msg('user', 60)], secondsAgo(5));
      expect(result).toEqual({ isActive: true, status: 'Claude Code working...' });
    });

    it('is active for a recent user message with recent file activity', () => {
      const result = stateCalculator.detectRealClaudeActivity([msg('user', 2)], minutesAgo(5));
      expect(result).toEqual({ isActive: true, status: 'Claude Code working...' });
    });

    it('reports Claude finishing for a very recent assistant message', () => {
      const result = stateCalculator.detectRealClaudeActivity([msg('assistant', 1)], minutesAgo(3));
      expect(result).toEqual({ isActive: true, status: 'Claude Code finishing...' });
    });

    it('detects tool activity as an active session', () => {
      const withTool = msg('assistant', 8, {
        content: [{ type: 'tool_use', id: 'toolu_1' }],
      });
      const result = stateCalculator.detectRealClaudeActivity([withTool], minutesAgo(12));
      expect(result).toEqual({ isActive: true, status: 'Active session' });
    });

    it('reports inactive with a null status when nothing matches', () => {
      const result = stateCalculator.detectRealClaudeActivity([msg('user', 120)], minutesAgo(90));
      expect(result).toEqual({ isActive: false, status: null });
    });
  });

  describe('quickStateCalculation', () => {
    const conversation = (mins) => ({
      project: 'my-project',
      lastModified: minutesAgo(mins),
    });

    it('returns null when no running process matches the conversation', () => {
      const result = stateCalculator.quickStateCalculation(conversation(1), [
        { workingDir: '/somewhere/else', command: 'node other.js' },
      ]);
      expect(result).toBeNull();
    });

    it('returns null when there are no running processes at all', () => {
      expect(stateCalculator.quickStateCalculation(conversation(1), [])).toBeNull();
    });

    it('reports Claude working when the file changed in the last 30 seconds', () => {
      const conv = { project: 'my-project', lastModified: secondsAgo(5) };
      const result = stateCalculator.quickStateCalculation(conv, [
        { workingDir: '/home/dev/my-project', command: 'claude' },
      ]);
      expect(result).toBe('Claude Code working...');
    });

    it('reports awaiting user input between 30 seconds and 5 minutes', () => {
      const conv = { project: 'my-project', lastModified: secondsAgo(120) };
      const result = stateCalculator.quickStateCalculation(conv, [
        { workingDir: '/home/dev/my-project', command: 'claude' },
      ]);
      expect(result).toBe('Awaiting user input...');
    });

    it('reports user typing beyond 5 minutes', () => {
      const conv = { project: 'my-project', lastModified: minutesAgo(20) };
      const result = stateCalculator.quickStateCalculation(conv, [
        { workingDir: '/home/dev/my-project', command: 'claude' },
      ]);
      expect(result).toBe('User typing...');
    });

    it('matches on the command string as well as the working directory', () => {
      const conv = { project: 'my-project', lastModified: secondsAgo(5) };
      const result = stateCalculator.quickStateCalculation(conv, [
        { workingDir: '/elsewhere', command: 'node my-project/index.js' },
      ]);
      expect(result).toBe('Claude Code working...');
    });
  });

  describe('getStateClass', () => {
    it('maps working states to the working class', () => {
      expect(stateCalculator.getStateClass('Claude Code working...')).toBe('working');
    });

    it('maps typing states to the typing class', () => {
      expect(stateCalculator.getStateClass('User typing...')).toBe('typing');
    });

    it('returns an empty class for everything else', () => {
      expect(stateCalculator.getStateClass('Idle')).toBe('');
      expect(stateCalculator.getStateClass('Active session')).toBe('');
    });
  });

  describe('clearCache', () => {
    it('empties the process cache', () => {
      stateCalculator.processCache.set('a', 'b');
      expect(stateCalculator.processCache.size).toBe(1);

      stateCalculator.clearCache();
      expect(stateCalculator.processCache.size).toBe(0);
    });
  });
});
