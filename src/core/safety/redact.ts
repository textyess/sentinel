/**
 * Redact secrets before anything reaches a log line. The single chokepoint for
 * connection strings, URL credentials, bearer/basic tokens, and key=value pairs.
 */
export function redactSecret(value: string): string {
    return value
        .replace(/(\w+:\/\/)([^:@/\s]*):([^@\s]+)@/g, "$1$2:***@")
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, "$1 ***")
        .replace(
            /\b(password|pwd|secret|token|api[_-]?key|key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|jwt|sig|signature|code|invite|reset)=([^&"\s]+)/gi,
            "$1=***",
        );
}
