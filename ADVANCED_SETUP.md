# 🚀 EXAMVAULT ADVANCED BOT - SETUP GUIDE

## 📋 WHAT'S NEW (Advanced Version 2.0)

### Previous Version (v1.0)
✅ Fetch pre-existing questions from Notion
✅ Daily automated delivery
✅ Quiz interface

### New Advanced Features (v2.0)
✨ **User scheduling** - Plan topics the night before
✨ **AI question generation** - Claude AI generates fresh questions
✨ **Nested Notion structure** - Exam → Subject → Topic → Questions
✨ **Automatic saving** - Generated questions auto-save to Notion
✨ **Dynamic testing** - Questions created on-demand at 7 AM
✨ **Flexible timing** - Test runs exactly when user schedules

---

## 🎯 HOW IT WORKS (User Perspective)

### Evening (Night Before)
```
User sends /start
    ↓
User clicks "📚 Schedule Test"
    ↓
Select Exam (SSC CGL, RRB NTPC, etc.)
    ↓
Enter Subject (Polity, Maths, etc.)
    ↓
Enter Topic (Articles of Constitution, etc.)
    ↓
✅ Test scheduled for tomorrow 7 AM
```

### Next Morning (7 AM)
```
⏰ Telegram notification
    ↓
🤖 Claude AI generates 10 questions
    ↓
💾 Saved to Notion (nested structure)
    ↓
📱 Quiz starts on Telegram
    ↓
User answers questions
    ↓
✅ Score shown + Explanations
```

### Result
```
Notion Database Structure:
├── SSC CGL (Exam)
│   ├── Polity (Subject)
│   │   ├── Articles of Constitution (Topic - Generated Today)
│   │   │   ├── Q1: Article 1 definition... ✅
│   │   │   ├── Q2: Right to Equality... ✅
│   │   │   └── Q3: ...
│   │   └── Amendments (Topic)
│   └── Maths
└── RRB NTPC
```

---

## 🔑 CREDENTIALS NEEDED

### 1. Telegram Bot Token (Same as v1)
- @BotFather → /newbot → Copy token

### 2. Notion API Key (Same as v1)
- notion.so/my-integrations → Create integration

### 3. Notion Parent Database ID (NEW)
- This is the ROOT database where Exams are stored
- Create a new Notion database called "Exams"
- Copy its ID from URL

### 4. Claude API Key (NEW!)
```
1. Visit: https://console.anthropic.com/
2. Sign up for Anthropic account
3. Go to API keys section
4. Create new key
5. Copy the key (starts with sk-ant-...)
```

---

## ⚡ SETUP STEPS

### Step 1: Get All Credentials (10 minutes)

#### Telegram Token
```
Telegram → @BotFather → /newbot
Token: 123456789:ABCdefGHI...
```

#### Notion API Key
```
https://notion.so/my-integrations
Key: secret_abc123xyz...
```

#### Notion Database ID
```
1. Create new database in Notion called "Exams"
2. Open it
3. Copy from URL: https://notion.so/[THIS_PART]?v=...
ID: abcdef123456789...
```

#### Claude API Key
```
https://console.anthropic.com/account/keys
Key: sk-ant-...
```

#### Your Chat ID
```
(Same as v1)
Send message to bot
Visit: https://api.telegram.org/bot[TOKEN]/getUpdates
ID: 987654321
```

### Step 2: Setup Code (5 minutes)

```bash
# Clone/download files
cd examvault-advanced

# Install dependencies
npm install

# Create .env file
cp advanced_env.example .env

# Edit .env with all 4 credentials
nano .env

# Test locally
npm start

# Expected output:
# 🤖 ExamVault Advanced Bot is running...
# ⏰ Monitoring for scheduled tests...
```

### Step 3: Create Notion Structure (Optional - Bot Creates Automatically)

Your Notion root database should look like:

```
📊 Exams (Parent Database)
│
├── Name (Text)
├── Created (Date)
└── (Nested databases/pages created per exam)
```

Bot will automatically create:
- **Exam pages** (SSC CGL, RRB NTPC, etc.)
- **Subject pages** under each exam
- **Topic pages** under each subject
- **Questions** under each topic

---

## 🧪 TEST LOCALLY

```bash
npm start
```

Expected console output:
```
🤖 ExamVault Advanced Bot is running...
⏰ Monitoring for scheduled tests...
```

On Telegram:
1. Send `/start`
2. Click "📚 Schedule Test"
3. Select exam, subject, topic
4. ✅ Test scheduled message
5. Click "🎯 Take Test Now" to test immediately
6. Questions generated + saved

---

## 🚀 DEPLOY TO RENDER

### Same as v1, but with new environment variables:

1. Push to GitHub
2. Go to render.com
3. Create Web Service
4. Connect GitHub repo
5. Add environment variables:

```env
TELEGRAM_BOT_TOKEN=...
NOTION_API_KEY=...
NOTION_PARENT_DB=...
CLAUDE_API_KEY=...
ADMIN_CHAT_ID=...
```

6. Deploy!

---

## ⚙️ NOTION DATABASE SETUP (DETAILED)

### Parent Database Structure

Create a database in Notion with this structure:

#### Properties of "Exams" database:
```
Name              | Text/Title (Primary)
Created           | Date
Type              | Select (Exam/Subject/Topic)
Status            | Status (Scheduled/Generated/Completed)
Difficulty        | Select (Easy/Medium/Hard)
```

#### Auto-Created Structure by Bot:

```
When user schedules test for:
Exam: SSC CGL
Subject: Polity  
Topic: Articles of Constitution

Bot creates:
├─ Page: "SSC CGL" (Type: Exam)
│  ├─ Page: "Polity" (Type: Subject)
│  │  ├─ Page: "Articles of Constitution" (Type: Topic)
│  │  │  ├─ Page: "Question 1..." 
│  │  │  │  Properties:
│  │  │  │  - Question: "What is Article 1?"
│  │  │  │  - Option A: "..."
│  │  │  │  - Option B: "..."
│  │  │  │  - Option C: "..."
│  │  │  │  - Option D: "..."
│  │  │  │  - Correct Answer: "A"
│  │  │  │  - Explanation: "..."
│  │  │  │  - Difficulty: "Medium"
```

**No manual setup needed!** Bot creates everything automatically.

---

## 🔧 CUSTOMIZATION

### Change Test Time

**File:** `telegram_advanced_bot.js`
**Find line:** `cron.schedule('* * * * *'`

Change to specific time using cron format:
```javascript
// 7 AM daily:
cron.schedule('0 7 * * *', async () => {

// 8 AM daily:
cron.schedule('0 8 * * *', async () => {

// 7:30 AM daily:
cron.schedule('30 7 * * *', async () => {

// Every 6 hours:
cron.schedule('0 */6 * * *', async () => {
```

### Change Question Count

**Find:** `generateQuestionsWithClaude(..., 10)`
**Change to:** `generateQuestionsWithClaude(..., 20)` for 20 questions

### Change Exam Types

**In command handlers, modify:**
```javascript
inline_keyboard: [
  [{ text: 'SSC CGL', callback_data: 'exam_ssc_cgl' }],
  [{ text: 'RRB NTPC', callback_data: 'exam_rrb_ntpc' }],
  // Add more exams here
]
```

### Change Subjects

Add more subjects to the topic input prompts:
```javascript
'What subject do you want to study?\n\n<i>E.g., Polity, Maths, History, Reasoning, GK, Science</i>'
```

---

## 🤖 HOW CLAUDE AI GENERATES QUESTIONS

The bot uses Claude API to generate questions:

```
Input:
- Topic: "Articles of Constitution"
- Exam: "SSC CGL"
- Subject: "Polity"
- Count: 10

Claude generates:
[
  {
    "question": "What does Article 1 of the Constitution state?",
    "optionA": "Defines the Union of India",
    "optionB": "Fundamental rights",
    "optionC": "Duties of citizens",
    "optionD": "Presidential powers",
    "correctAnswer": "A",
    "explanation": "Article 1 defines the Union of India and lists all states...",
    "difficulty": "Easy"
  },
  // ... 9 more questions
]
```

Questions are:
✅ Exam-specific
✅ Topic-focused
✅ With clear explanations
✅ Varying difficulty

---

## 💰 COST BREAKDOWN

| Component | Cost |
|-----------|------|
| Telegram | Free |
| Notion | Free (up to 1000 blocks) |
| Render | Free tier or $7+/month |
| Claude API | **$0.003 per 1K input tokens** |

**Example cost:**
- 10 questions per day
- ~2000 tokens per generation
- ~$0.006 per day
- **~$0.18/month** for Claude

Total: **Free or ~$7/month** (mostly hosting)

---

## ⚠️ IMPORTANT: CLAUDE API COSTS

Claude API is NOT free but is very cheap:

```
Input tokens: $0.003 per 1K tokens
Output tokens: $0.015 per 1K tokens

Example:
- Request: 500 tokens (topic, instructions)
- Response: 1500 tokens (10 questions)
- Cost: (500 × $0.003 + 1500 × $0.015) / 1000 = $0.0255

10 tests/day = $0.255/day = ~$7.65/month
```

**Vs ChatGPT:**
- Claude: $0.003 input / $0.015 output
- GPT-4: $0.03 input / $0.06 output (10x more expensive)

Claude is the cheapest option for this use case.

---

## 🔒 SECURITY NOTES

1. **Never commit `.env`** file to GitHub
2. **Rotate API keys** regularly
3. **Rate limit** Claude API calls (optional)
4. **Monitor** API usage
5. **Use environment variables** never hardcode

Add to `.gitignore`:
```
.env
node_modules/
*.log
```

---

## 🐛 TROUBLESHOOTING

### "Claude API Error"
```
1. Verify CLAUDE_API_KEY is correct
2. Check you have API credits
3. Verify API key is active
4. Check rate limits
```

### "Notion save failed"
```
1. Verify NOTION_API_KEY
2. Verify NOTION_PARENT_DB is correct
3. Ensure database is shared with integration
4. Check property names match
```

### "Questions not generating"
```
1. Check Claude API key
2. Check network connection
3. Check Claude API status
4. Verify request format is correct
5. Check response parsing
```

### "Test doesn't run at scheduled time"
```
1. Verify server timezone
2. Check cron syntax
3. Ensure bot is running
4. Check logs for errors
5. Verify system time is correct
```

---

## 📊 MONITORING

### Check API Usage
```bash
# View logs
npm start 2>&1 | tee bot.log

# Monitor Claude API
Visit: https://console.anthropic.com/account/usage

# Monitor Notion
Check your Notion database for new questions
```

---

## 🎯 BEST PRACTICES

1. **Test locally first**
```bash
npm start
```

2. **Start with small changes**
- Modify 1 question count
- Test it
- Then change more

3. **Monitor logs**
```bash
npm start 2>&1 | tee bot.log
tail -f bot.log
```

4. **Regular backups**
- Export Notion database weekly
- Save `.env` separately

5. **Track API costs**
- Monitor Claude API usage daily
- Set alerts for high usage

---

## 📈 SCALING

### If API costs get high:

**Option 1: Reduce question count**
```javascript
generateQuestionsWithClaude(..., 5) // Instead of 10
```

**Option 2: Reduce frequency**
```javascript
// Only generate at 7 AM on weekdays
cron.schedule('0 7 * * 1-5', async () => {
```

**Option 3: Use GPT-4o Mini (cheaper)**
```javascript
// Costs ~30% of Claude
model: 'gpt-4o-mini'
```

**Option 4: Cache questions**
```javascript
// Reuse questions for popular topics
// Only generate new ones on demand
```

---

## 🚀 NEXT FEATURES

Potential additions:

1. **User profiles** - Save preferences
2. **Progress tracking** - Track improvement over time
3. **Leaderboard** - Compete with friends
4. **Custom exams** - Let users create custom tests
5. **Email digest** - Daily summary emails
6. **Analytics** - Detailed performance reports
7. **Mobile app** - Native iOS/Android

---

## 📞 SUPPORT

### Common Questions

**Q: Why Claude instead of ChatGPT?**
A: Claude is better at structured output and exam questions. Also cheaper.

**Q: Can I use GPT-4?**
A: Yes! Modify the API call in `generateQuestionsWithClaude()`. More expensive but also good.

**Q: How do I increase question quality?**
A: Improve the system prompt. Add specific guidelines for your exam.

**Q: Can I disable Notion saving?**
A: Yes, comment out the Notion save section. Questions still work.

**Q: How do I add more exams?**
A: Add buttons in the schedule_test callback handler.

---

## ✅ SUCCESS CHECKLIST

- [ ] Got all 4 credentials
- [ ] Created Notion database
- [ ] npm install successful
- [ ] .env file configured
- [ ] npm start runs without errors
- [ ] Bot responds to /start
- [ ] Can schedule test
- [ ] Questions generate (takes ~5 seconds)
- [ ] Questions save to Notion
- [ ] Quiz works properly
- [ ] Deployed on Render
- [ ] Monitor API costs
- [ ] Share with users!

---

## 🎓 FINAL NOTES

This advanced version:
- ✅ Generates unique questions daily
- ✅ Scales to unlimited users
- ✅ Saves everything to Notion
- ✅ Costs pennies per test
- ✅ Runs 24/7 automatically
- ✅ Creates professional nested structure

**You're ready to launch!** 🚀

---

**Version:** 2.0.0 (Advanced)
**Last Updated:** March 2026
**Status:** Production Ready ✅
