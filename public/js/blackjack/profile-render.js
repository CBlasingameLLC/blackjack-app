// ==========================================
// profile-render.js — the Profile tab's dynamic content: rank/level/XP
// header, the full achievements catalog (locked + unlocked), and today's
// challenge in full detail.
//
// The Settings section of the Profile tab is NOT rendered here — it's
// static markup in index.html (the same [data-setting]-driven controls
// ui-bindings.js's binder already wires for the in-game overlay), just
// living as a sibling block under the Profile panel. This file only owns
// the parts that are actually dynamic/computed.
//
// render(container) mirrors ReferenceRender/StatsRender/PathRender's
// contract — called by hub.js on tab activation.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Storage = BJ.Storage;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }
    function icon(faClass) {
        var i = document.createElement('i');
        i.className = 'icon solid ' + faClass;
        return i;
    }

    function buildRankHeader() {
        var Gam = BJ.Gamification;
        var progression = Storage.getProgression();
        var ladder = Gam.getLadderStatus();
        var level = Gam.getLevel(progression.xp);
        var xpIntoLevel = Gam.getXPIntoLevel(progression.xp);
        var xpPerLevel = Gam.getXPPerLevel();

        var card = el('div', 'rank-header');
        card.appendChild(el('span', 'rank-header__title', ladder.rankTitle));
        card.appendChild(el('span', 'rank-header__level', 'Level ' + level));

        var track = el('div', 'rank-header__track');
        var fill = el('div', 'rank-header__fill');
        fill.style.width = Math.round((xpIntoLevel / xpPerLevel) * 100) + '%';
        track.appendChild(fill);
        card.appendChild(track);

        card.appendChild(el('span', 'rank-header__xp', xpIntoLevel + ' / ' + xpPerLevel + ' XP to next level · ' + progression.xp + ' total'));

        var streakRow = el('div', 'rank-header__streaks');
        streakRow.appendChild(el('span', 'rank-header__streak', 'Current streak: ' + progression.currentStreak));
        streakRow.appendChild(el('span', 'rank-header__streak', 'Best: ' + progression.bestStreak));
        card.appendChild(streakRow);

        return card;
    }

    function buildChallengeSection() {
        var Gam = BJ.Gamification;
        var challenge = Gam.getTodayChallenge();
        var d = Gam.describeChallenge(challenge);

        var section = el('div', 'stats-section');
        section.appendChild(el('h3', 'stats-section-title', "Today's Challenge"));

        var card = el('div', 'challenge-card' + (d.completed ? ' challenge-card--done' : ''));
        var head = el('div', 'challenge-card__head');
        head.appendChild(el('span', 'challenge-card__label', d.completed ? 'Done' : 'In Progress'));
        if (d.completed) head.appendChild(icon('fa-check-circle'));
        card.appendChild(head);
        card.appendChild(el('div', 'challenge-card__title', d.title));
        card.appendChild(el('p', 'challenge-card__desc', d.description));

        var track = el('div', 'challenge-card__track');
        var fill = el('div', 'challenge-card__fill');
        fill.style.width = d.pct + '%';
        track.appendChild(fill);
        card.appendChild(track);
        card.appendChild(el('span', 'challenge-card__count', d.progress + ' / ' + d.target));

        section.appendChild(card);
        return section;
    }

    function buildAchievementsSection() {
        var unlockedList = Storage.getAchievements();
        var unlockedMap = {};
        unlockedList.forEach(function (a) { unlockedMap[a.id] = a; });

        var section = el('div', 'stats-section');
        var title = el('h3', 'stats-section-title', 'Achievements');
        section.appendChild(title);
        section.appendChild(el('p', 'stats-note', unlockedList.length + ' / ' + BJ.Gamification.ACHIEVEMENTS.length + ' unlocked'));

        var grid = el('div', 'achv-grid');
        // Unlocked first (most recent first), then locked — the grid reads
        // as "what I've done" before "what's left to chase".
        var defs = BJ.Gamification.ACHIEVEMENTS.slice();
        defs.sort(function (a, b) {
            var ua = !!unlockedMap[a.id], ub = !!unlockedMap[b.id];
            if (ua === ub) return 0;
            return ua ? -1 : 1;
        });

        defs.forEach(function (def) {
            var unlocked = unlockedMap[def.id];
            var card = el('div', 'achv-card' + (unlocked ? ' achv-card--unlocked' : ' achv-card--locked'));
            var iconWrap = el('span', 'achv-card__icon');
            iconWrap.appendChild(icon(def.icon));
            card.appendChild(iconWrap);
            card.appendChild(el('span', 'achv-card__title', def.title));
            card.appendChild(el('span', 'achv-card__desc', def.description));
            if (unlocked) {
                var d = new Date(unlocked.unlockedAt);
                card.appendChild(el('span', 'achv-card__date', d.toLocaleDateString()));
            }
            grid.appendChild(card);
        });
        section.appendChild(grid);
        return section;
    }

    var ProfileRender = {
        render(container) {
            if (typeof document === 'undefined') return false;
            if (!container || !BJ.Gamification || !Storage) return false;
            container.innerHTML = '';

            container.appendChild(buildRankHeader());
            container.appendChild(buildChallengeSection());
            container.appendChild(buildAchievementsSection());

            return true;
        }
    };

    BJ.ProfileRender = ProfileRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ProfileRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
