#!/bin/bash

# Publish Script for @otel-elite/instrumentation (Beta)
# Automates build, verification, and publishing.

set -e

echo "🚀 Starting Publish Process..."

# 1. Clean and Install
echo "📦 Installing modules..."
rm -rf node_modules package-lock.json
npm install

# 2. Build
echo "🔨 Building project..."
rm -rf dist
npm run build

# 3. Lint / Verify
echo "🔍 Verifying code..."
npm run lint

# 4. Version Check
VERSION=$(node -p "require('./package.json').version")
echo "ℹ️  Current version: $VERSION"
echo "❓ Do you want to publish version $VERSION? (y/n)"
read -r response
if [[ "$response" != "y" ]]; then
    echo "❌ Publish cancelled."
    exit 1
fi

# 5. Publish
echo "🚀 Publishing to npm..."
# Use --access public if it's a scoped package intended for public use
# npm publish --access public
npm publish

echo "✅ Successfully published version $VERSION!"
