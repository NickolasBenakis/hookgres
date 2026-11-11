Output ../rollback-demo.mp4

Set Shell "bash"
Set FontSize 17
Set Width 1240
Set Height 860
Set Padding 28
Set Theme "GitHub Dark"
Set TypingSpeed 45ms
Set WindowBar Colorful
Set WindowBarSize 36

Hide
Type "source setup.sh && export GIT_PAGER=cat" Enter
Sleep 1.5s
Type "clear" Enter
Show

Type "bat --style=plain --paging=never before.ts" Sleep 300ms Enter
Sleep 9s
Type "clear" Enter
Type "node receiver.ts &   # your customer's server" Sleep 300ms Enter
Sleep 1.2s
Type "node before.ts" Sleep 300ms Enter
Sleep 4s
Ctrl+C
Sleep 400ms
Type "psql -c 'select id, status from invoices order by id'" Sleep 300ms Enter
Sleep 2.5s
Type "# acme marked in_124 paid. Your database says it's open." Sleep 300ms Enter
Sleep 3.5s

Hide
Type "reset && clear" Enter
Sleep 1s
Show

Type "git diff --no-index before.ts after.ts" Sleep 300ms Enter
Sleep 7s
Type "node after.ts" Sleep 300ms Enter
Sleep 4.5s
Ctrl+C
Sleep 400ms
Type "psql -c 'select event_type, payload from hookgres.messages'" Sleep 300ms Enter
Sleep 2.5s
Type "# one webhook, for the invoice that was paid." Sleep 300ms Enter
Sleep 4s

Hide
Type "kill %1" Enter
Sleep 300ms
