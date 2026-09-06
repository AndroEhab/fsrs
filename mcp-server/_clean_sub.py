import io

p = 'src/tools.ts'
s = io.open(p, encoding='utf-8').read()

# The file's raw bytes contain: present the choice \\\"Review session complete — choose Finish or Continue review\\\" ...
# (in the TS source these are backslash-backslash-quote, i.e. escaped quotes).
old = """When the session completes and continuationAvailable is true, present the choice \\\\\"Review session complete \u2014 choose Finish or Continue review\\\\\" (Continue means start a NEW spaced-repetition session to cover the remaining due cards); when continuationAvailable is false, say \\\\\"Review session complete \u2014 choose Finish (all due cards were reviewed)\\\\". If a snapshot card was deleted in the meantime it is skipped automatically. A session that is already completed or ended rejects the submission \u2014 start a new session. Optionally pass reviewAt (ISO 8601) as the review time; defaults to server time. Use this after the user answers the current card.\\',"""
new = """When the session completes, the widget shows the Finish/Continue choice \u2014 do not narrate it. If a snapshot card was deleted in the meantime it is skipped automatically. A session that is already completed or ended rejects the submission \u2014 start a new session. Optionally pass reviewAt (ISO 8601) as the review time; defaults to server time. Use this after the user answers the current card.\\',"""
print('submit tail count:', s.count(old))
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('submit tail cleaned')
