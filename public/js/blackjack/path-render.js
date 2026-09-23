// ==========================================
// path-render.js — the Path tab: tiers, sections, checkouts.
//
// PURELY DISPLAY + light routing. All mastery/checkout/rust math lives in
// mastery.js (read here, never recomputed) and XP/challenge in
// gamification.js — this file only builds DOM and, on a tap, applies the
// settings a section needs and routes into the right screen.
//
// THE TIERS ARE RENDERED AS COLUMNS, NOT AS ONE LONG LIST, and that is a
// layout decision doing real work. Nine sections stacked in one column on a
// 1280x800 screen leaves roughly fifty pixels a row, which is not enough for
// a meter and a status and forces the taglines out — and the tagline is
// where a section says what it is for. Three tier columns of two to four
// rows each fit comfortably, and they make the SHAPE of the ladder visible:
// the whole point of splitting basic strategy into four sections is that you
// can see at a glance which one you have been avoiding.
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

    var STATUS_LABEL = {
        mastered: 'Mastered',
        rusty: 'Rusty',
        ready: 'Checkout',
        'in-progress': 'In Progress',
        'not-started': 'Not Started'
    };

    /** The standalone count-drill screens, as opposed to engine game modes. */
    var DRILL_SCREENS = { manual: 1, estimation: 1, truecount: 1 };

    /**
     * Opens whatever a section actually practises. The split matters: three
     * of the nine live on their own screen with their own shoe (count-drills
     * .js) and the rest are engine game modes, and routing a count drill
     * through setGameMode would start a round the drill has no use for.
     */
    function launchSection(section) {
        var gm = BJ.instance && BJ.instance.gameManager;
        if (!gm) return;

        if (DRILL_SCREENS[section.drill]) {
            if (BJ.CountDrills) BJ.CountDrills.open(section.drill);
            return;
        }
        if (section.drill === 'testout') {
            gm.updateSettings({ casualMode: false });
        }
        gm.setGameMode(section.drill); // onGameModeChange handles the screen swap
    }

    /**
     * Starts a checkout and drops straight into it. Eligibility is re-checked
     * inside Mastery.startCheckout — this is a button, and a button that can
     * be clicked in a stale render must not be the thing deciding whether a
     * gate opens.
     */
    function beginCheckout(section) {
        if (!BJ.Mastery) return;
        var attempt = BJ.Mastery.startCheckout(section.id);
        if (!attempt) return;
        launchSection(section);
    }

    // ------------------------------------------------------------------
    // section card
    // ------------------------------------------------------------------

    /**
     * The meter shows VOLUME, not accuracy, because volume is the thing that
     * moves steadily and can be finished. Accuracy is reported as a number
     * beside it — a bar that jitters up and down a percentage point per
     * decision reads as noise and tells you nothing about how far through you
     * are.
     */
    function buildMeter(s) {
        var wrap = el('div', 'ladder-meter');
        var track = el('div', 'ladder-meter__track');
        var fill = el('div', 'ladder-meter__fill ladder-meter__fill--' + s.status);
        fill.style.width = (s.mastered ? 100 : s.volumePct) + '%';
        track.appendChild(fill);
        wrap.appendChild(track);

        var label;
        if (s.mastered) {
            // A mastered section swaps the volume readout for current form:
            // "how far through" stops being the question the moment it is
            // finished, and "is it still good" becomes it.
            label = s.formPct === null
                ? 'Certified'
                : 'Form ' + s.formPct + '% over last ' + s.formSamples;
        } else if (s.decisions === 0) {
            label = '0 / ' + s.volume + ' decisions';
        } else {
            label = s.decisions + ' / ' + s.volume + ' decisions'
                + (s.lifetimePct === null ? '' : '  ·  ' + s.lifetimePct + '%');
        }
        wrap.appendChild(el('span', 'ladder-meter__label', label));
        return wrap;
    }

    function buildSectionCard(s, isCurrent) {
        var card = el('div', 'ladder-stage ladder-stage--' + s.status
            + (isCurrent ? ' ladder-stage--current' : '')
            + (s.blocked ? ' ladder-stage--blocked' : ''));

        var head = el('div', 'ladder-stage__head');
        var iconWrap = el('span', 'ladder-stage__icon');
        iconWrap.appendChild(icon(s.blocked ? 'fa-lock' : s.icon));
        head.appendChild(iconWrap);

        var titleWrap = el('div', 'ladder-stage__titles');
        var titleRow = el('div', 'ladder-stage__title-row');
        titleRow.appendChild(el('span', 'ladder-stage__num', String(s.order)));
        titleRow.appendChild(el('span', 'ladder-stage__title', s.title));
        titleWrap.appendChild(titleRow);
        titleWrap.appendChild(el('span', 'ladder-stage__tagline', s.tagline));
        head.appendChild(titleWrap);

        head.appendChild(el('span', 'ladder-stage__pill ladder-stage__pill--' + s.status, STATUS_LABEL[s.status]));
        card.appendChild(head);
        card.appendChild(buildMeter(s));

        // The one sentence saying what is actually in the way. Without it a
        // greyed-out checkout button is a dead end the player has to guess at.
        if (s.reason) card.appendChild(el('p', 'ladder-stage__reason', s.reason));

        var actions = el('div', 'ladder-stage__actions');

        var practise = el('button', 'button ladder-stage__btn',
            s.mastered ? 'Practise' : (s.decisions === 0 ? 'Start' : 'Continue'));
        practise.type = 'button';
        practise.addEventListener('click', function () { launchSection(s); });
        actions.appendChild(practise);

        if (s.checkoutAvailable) {
            if (s.checkout.kind === 'countdown') {
                // Nothing to start: it accrues across runs of the drill, so
                // the card reports progress instead of offering a button that
                // would have to do nothing.
                actions.appendChild(el('span', 'ladder-stage__checkout-note',
                    s.checkout.progress + ' / ' + s.checkout.size + ' clean'));
            } else {
                var take = el('button', 'button button--primary ladder-stage__btn', 'Take checkout');
                take.type = 'button';
                take.addEventListener('click', function () { beginCheckout(s); });
                actions.appendChild(take);
            }
        }

        card.appendChild(actions);
        return card;
    }

    // ------------------------------------------------------------------
    // tiers
    // ------------------------------------------------------------------

    function buildTierColumn(tier, sections, currentId) {
        var col = el('div', 'ladder-tier' + (tier.unlocked ? '' : ' ladder-tier--locked'));

        var head = el('div', 'ladder-tier__head');
        head.appendChild(el('span', 'ladder-tier__title', tier.title));
        head.appendChild(el('span', 'ladder-tier__count', tier.mastered + ' / ' + tier.total));
        col.appendChild(head);
        col.appendChild(el('p', 'ladder-tier__blurb', tier.unlocked
            ? tier.blurb
            : 'Checkouts locked until the previous tier is complete — practice is always open.'));

        var list = el('div', 'ladder-tier__list');
        sections.forEach(function (s) { list.appendChild(buildSectionCard(s, s.id === currentId)); });
        col.appendChild(list);
        return col;
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

    /** The live checkout banner — an attempt in flight is the most important thing on the screen. */
    function buildActiveCheckout(active, status) {
        var def = BJ.Mastery.definitionFor(active.sectionId);
        var card = el('div', 'checkout-live checkout-live--' + active.verdict);

        var title = active.verdict === 'active'
            ? 'Checkout in progress — ' + (def ? def.title : active.sectionId)
            : (active.verdict === 'passed' ? 'Checkout passed' : 'Checkout failed');
        card.appendChild(el('div', 'checkout-live__title', title));

        if (active.kind === 'shoes') {
            card.appendChild(el('p', 'checkout-live__body',
                'Shoe ' + Math.min(active.shoesDone + 1, active.size) + ' of ' + active.size
                + '  ·  ' + active.correct + ' / ' + active.decisions + ' correct'
                + '  ·  needs ' + active.requiredPct + '%'));
        } else if (active.verdict === 'active') {
            card.appendChild(el('p', 'checkout-live__body',
                active.decisions + ' / ' + active.size + ' clean — one mistake ends it.'));
        } else if (active.verdict === 'failed') {
            var m = active.brokenBy;
            card.appendChild(el('p', 'checkout-live__body',
                'Broke at decision ' + active.decisions
                + (m ? ' — ' + m.handDescription + ' vs ' + (m.dealerUpcard === 11 ? 'A' : m.dealerUpcard)
                    + ': played ' + m.playerAction + ', correct was ' + m.correctAction + '.'
                    : '.')));
        } else {
            card.appendChild(el('p', 'checkout-live__body', 'Section certified.'));
        }

        var row = el('div', 'checkout-live__actions');
        if (active.verdict === 'active') {
            var resume = el('button', 'button button--primary', 'Resume');
            resume.type = 'button';
            resume.addEventListener('click', function () {
                var s = status.sections.filter(function (x) { return x.id === active.sectionId; })[0];
                if (s) launchSection(s);
            });
            row.appendChild(resume);

            var quit = el('button', 'button', 'Abandon');
            quit.type = 'button';
            quit.addEventListener('click', function () {
                BJ.Mastery.abortCheckout();
                PathRender.render(document.getElementById('hub-path-body'));
            });
            row.appendChild(quit);
        } else {
            var done = el('button', 'button button--primary', 'Dismiss');
            done.type = 'button';
            done.addEventListener('click', function () {
                BJ.Mastery.clearCheckout();
                PathRender.render(document.getElementById('hub-path-body'));
            });
            row.appendChild(done);
        }
        card.appendChild(row);
        return card;
    }

    var PathRender = {
        render(container) {
            if (typeof document === 'undefined') return false;
            if (!container || !BJ.Gamification || !BJ.Mastery) return false;
            container.innerHTML = '';

            var status = BJ.Mastery.getStatus();

            var header = el('div', 'path-header');
            header.appendChild(el('span', 'path-header__rank', status.rankTitle));
            header.appendChild(el('span', 'path-header__note',
                status.masteredCount + ' / ' + status.totalSections + ' sections mastered'));
            container.appendChild(header);

            if (status.active) {
                container.appendChild(buildActiveCheckout(status.active, status));
            } else {
                container.appendChild(buildChallengeCard(BJ.Gamification.getTodayChallenge()));
            }

            var tiers = el('div', 'ladder-tiers');
            status.tiers.forEach(function (tier) {
                var own = status.sections.filter(function (s) { return s.tier === tier.id; });
                tiers.appendChild(buildTierColumn(tier, own, status.currentSectionId));
            });
            container.appendChild(tiers);

            return true;
        }
    };

    BJ.PathRender = PathRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PathRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
