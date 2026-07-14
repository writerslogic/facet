import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/lib/log.js';

describe('createLogger', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('info emits a single JSON line with level and msg', () => {
        const log = createLogger();
        log.info('hello');
        expect(logSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsed).toMatchObject({ level: 'info', msg: 'hello' });
    });

    it('warn emits a single JSON line with level warn', () => {
        const log = createLogger();
        log.warn('watch out', { code: 42 });
        expect(logSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsed).toMatchObject({ level: 'warn', msg: 'watch out', code: 42 });
    });

    it('error emits via console.error with level error', () => {
        const log = createLogger();
        log.error('boom', new Error('oops'));
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(errorSpy.mock.calls[0]![0] as string);
        expect(parsed).toMatchObject({ level: 'error', msg: 'boom' });
        expect(parsed.err).toMatchObject({ message: 'oops', name: 'Error' });
    });

    it('includes base fields in every log line', () => {
        const log = createLogger({ requestId: 'abc123' });
        log.info('test');
        const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsed.requestId).toBe('abc123');
    });

    it('strips ip field from fields', () => {
        const log = createLogger();
        // Cast to bypass compile-time guard to test runtime stripping
        log.info('test', { other: 'value' } as Record<string, string>);
        const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsed.ip).toBeUndefined();
        expect(parsed.other).toBe('value');
    });

    it('strips ip field at runtime even when passed via cast', () => {
        const log = createLogger();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (log.info as any)('test', { ip: '1.2.3.4', safe: 'yes' });
        const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsed.ip).toBeUndefined();
        expect(parsed.safe).toBe('yes');
    });

    it('strips CF-Connecting-IP field at runtime', () => {
        const log = createLogger();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (log.info as any)('test', { 'CF-Connecting-IP': '1.2.3.4', safe: 'yes' });
        const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
        expect(parsed['CF-Connecting-IP']).toBeUndefined();
        expect(parsed.safe).toBe('yes');
    });

    it('emits exactly one line per call', () => {
        const log = createLogger();
        log.info('a');
        log.warn('b');
        log.error('c');
        expect(logSpy).toHaveBeenCalledTimes(2);
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });
});
