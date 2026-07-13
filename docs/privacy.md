<!-- Privacy model: cookieless, salted-hash unique counting. Filled in by T032. -->

# Privacy model

> Stub — expanded in T032.

Countless is cookieless. Unique visitors are counted with a daily-rotating hash:

```
visitor_hash = SHA-256(ip + user_agent + daily_salt + site_id)
```

- Raw IP addresses are never stored.
- The salt rotates every UTC day, so hashes cannot be linked across days.
- No cross-site identifiers, no fingerprinting beyond the daily bucket.
