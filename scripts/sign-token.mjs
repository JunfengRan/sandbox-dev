#!/usr/bin/env node
/**
 * Sign a broker JWT for server deployment.
 * Usage: JWT_SECRET=xxx node scripts/sign-token.js alice
 */
import jwt from 'jsonwebtoken'

const userId = process.argv[2]
const secret = process.env.JWT_SECRET

if (!userId || !secret) {
  console.error('Usage: JWT_SECRET=xxx node scripts/sign-token.js <user_id>')
  process.exit(1)
}

console.log(jwt.sign({ user_id: userId }, secret, { expiresIn: '7d' }))
