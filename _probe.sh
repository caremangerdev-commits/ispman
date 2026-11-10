cd /var/www/ispman
URL=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')
KEY=$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2- | tr -d '"'"'"' \r')
echo '--- one full lead row (columns) ---'
curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "$URL/rest/v1/leads?select=*&limit=1" | tr ',' '\n'
echo
echo '--- distinct roles in users ---'
curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "$URL/rest/v1/users?select=role" | tr ',' '\n' | sed 's/[][{}"]//g' | sort | uniq -c | sort -rn
