#!/bin/sh

# Find all JS files in the assets folder
for file in /usr/share/nginx/html/assets/*.js; do
  if [ -f "$file" ]; then
    # Replace the placeholder with the actual runtime environment variable
    sed -i "s|__GEMINI_API_KEY_PLACEHOLDER__|${GEMINI_API_KEY}|g" "$file"
  fi
done

# Pass control to nginx
exec nginx -g 'daemon off;'
