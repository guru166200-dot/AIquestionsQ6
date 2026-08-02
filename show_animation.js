const readline = require('readline');

function getGlowProgressBar(percent) {
    const totalSteps = 12; 
    const filledSteps = Math.min(Math.round((percent / 100) * totalSteps), totalSteps);
    const emptySteps = totalSteps - filledSteps;
    
    // Exact logic from the bot's telegram_advanced_bot.js
    const core = '█'.repeat(filledSteps);
    const aura = '░'.repeat(emptySteps);
    const spark = (percent > 0 && percent < 100) ? '✨' : (percent === 100 ? '🌟' : '');
    
    return `⟨ ${core}${spark}${aura} ⟩  ${percent}%`;
}

async function showAnimation() {
    console.log('\n✨ EXAMVAULT LUMINANCE ANIMATION DEMO');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const steps = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    
    for (const p of steps) {
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`🌟 Manifesting: ${getGlowProgressBar(p)}`);
        if (p < 100) {
            await new Promise(r => setTimeout(r, 400));
        }
    }
    
    console.log('\n\n✅ Manifestation Complete! 🌟\n');
}

showAnimation();
