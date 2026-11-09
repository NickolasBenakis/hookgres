Output ../terminal-demo.gif
Output ../terminal-demo.mp4

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
Type "source setup.sh" Enter
Sleep 1.5s
Type "clear" Enter
Show

Type "npm install hookgres pg" Sleep 300ms Enter
Sleep 2.5s
Type "bat --style=plain --paging=never app.ts" Sleep 300ms Enter
Sleep 11s
Type "clear" Enter
Type "node receiver.ts &   # your customer's server" Sleep 300ms Enter
Sleep 1.2s
Type "node app.ts" Sleep 300ms Enter
Sleep 10s
Ctrl+C
Sleep 600ms
Type "psql -c 'select attempt_number, status_code, duration_ms, created_at::time(0) from hookgres.attempts'" Sleep 300ms Enter
Sleep 4.5s

Hide
Type "kill %1" Enter
Sleep 300ms
