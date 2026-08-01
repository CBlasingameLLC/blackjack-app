// ==========================================
// path-render.js — the Path tab: the Skill Ladder.
//
// PURELY DISPLAY + light routing. All mastery/rank/challenge math lives in
// gamification.js (read here, never recomputed) — this file only builds
// DOM and, on a stage tap, applies the settings that stage needs (drill
// style / count checks) and routes into the right screen. It never touches
// game logic or persistence directly beyond that one settings nudge.
//
// render(container) mirrors ReferenceRender/StatsRender's contract — same
// pattern, own container, called by hub.js on tab activation.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

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

    var STATUS_LABEL = { mastered: 'Mastered', 'in-progress': 'In Progress', 'not-started': 'Not Started' };

    /**
     * Applies whatever settings a stage's practice actually needs, then
     * routes to the right screen. Stages 1/2/4 have 2–3 equally-valid
     * drills (no single unambiguous target), so those just open Practice
     * for the player to pick — Stage 3 needs specific settings turned on to
     * even BE what it claims to be, and Stage 5 has exactly one target
     * (Test Out), so those two get a direct, configured launch.
     */
    function launchStage(stageId) {
        var gm = BJ.instance && BJ.instance.gameManager;
        if (!gm) return;

        if (stageId === 'count-strategy') {
            gm.updateSettings({ drillStyle: 'full', drillCountChecks: true });
        }
        if (stageId === 'deviations') {
            gm.updateSettings({ casualMode: false });
            gm.setGameMode('testout'); // straight into Play — onGameModeChange handles the screen swap
            return;
        }
        if (BJ.Hub) BJ.Hub.selectTab('practice');
    }

    function buildMeter(stage) {
        var wrap = el('div', 'ladder-meter');
        var track = el('div', 'ladder-meter__track');
        var fill = el('div', 'ladder-meter__fill ladder-meter__fill--' + stage.status);
        fill.style.width = (stage.pct || 0) + '%';
        track.appendChild(fill);
        wrap.appendChild(track);

        var label = el('span', 'ladder-meter__label',
            stage.pct === null
                ? 'No decisions logged yet'
                : (stage.pct + '% · ' + stage.samples + (stage.samples < stage.minSamples ? '/' + stage.minSamples : '') + ' decisions'));
        wrap.appendChild(label);
        return wrap;
    }

    function buildStageCard(stage, isCurrent) {
        var card = el('button', 'ladder-stage ladder-stage--' + stage.status + (isCurrent ? ' ladder-stage--current' : ''));
        card.type = 'button';

        var head = el('div', 'ladder-stage__head');
        var iconWrap = el('span', 'ladder-stage__icon');
        iconWrap.appendChild(icon(stage.icon));
        head.appendChild(iconWrap);

        var titleWrap = el('div', 'ladder-stage__titles');
        var titleRow = el('div', 'ladder-stage__title-row');
        titleRow.appendChild(el('span', 'ladder-stage__num', String(stage.order)));
        titleRow.appendChild(el('span', 'ladder-stage__title', stage.title));
        titleWrap.appendChild(titleRow);
        titleWrap.appendChild(el('span', 'ladder-stage__tagline', stage.tagline));
        head.appendChild(titleWrap);

        var pill = el('span', 'ladder-stage__pill ladder-stage__pill--' + stage.status,
            isCurrent && stage.status !== 'mastered' ? 'Continue' : STATUS_LABEL[stage.status]);
        head.appendChild(pill);

        card.appendChild(head);
        card.appendChild(buildMeter(stage));

        card.addEventListener('click', function () { launchStage(stage.id); });
        return card;
    }

    function buildChallengeCard(challenge) {
        var d = BJ.Gamification.describeChallenge(challenge);
        var card = el('div', 'challenge-card' + (d.completed ? ' challenge-card--done' : ''));
        var head = el('div', 'challenge-card__head');
        head.appendChild(el('span', 'challenge-card__label', d.completed ? "Today's Challenge — Done" : "Today's Challenge"));
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

        return card;
    }

    var PathRender = {
        render(container) {
            if (typeof document === 'undefined') return false;
            if (!container || !BJ.Gamification) return false;
            container.innerHTML = '';

            var status = BJ.Gamification.getLadderStatus();

            var header = el('div', 'path-header');
            header.appendChild(el('span', 'path-header__rank', status.rankTitle));
            header.appendChild(el('span', 'path-header__note', status.masteredCount + ' / ' + status.stages.length + ' stages mastered'));
            container.appendChild(header);

            container.appendChild(buildChallengeCard(BJ.Gamification.getTodayChallenge()));

            var list = el('div', 'ladder-list');
            status.stages.forEach(function (stage) {
                list.appendChild(buildStageCard(stage, stage.id === status.currentStageId));
            });
            container.appendChild(list);

            return true;
        }
    };

    BJ.PathRender = PathRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PathRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
