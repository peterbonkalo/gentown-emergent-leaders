// ============================================================================
// GenTown mod: Emergent Leaders
// ----------------------------------------------------------------------------
// Gives every town a named leader with 2 personality traits (WorldBox-style
// individuals). Traits quietly steer the town's mood/wealth and drive small
// RimWorld-style stories: decrees, purges, coups, and succession, with a
// running biography ("desc") that grows on each leader as things happen to
// them.
//
// Built on GenTown's real mod API:
//   - Mod.event(id, data)   registers into gameEvents (random/daily/meta)
//   - Mod.afterLoad(fn)     runs once game data (constants, etc.) is ready
//   - reg / regAdd / regGet / regFilter / regSingle / regToArray
//   - the game's own "individual" registry, which exists but is otherwise
//     unused by the base game - this mod is what actually populates it
//   - regBrowserKeys / regBrowserValues, so leaders + traits show up
//     automatically in the town's (and the individual's own) info panel,
//     using the same {{regname:individual|ID}} system towns/species use -
//     no custom UI code needed, it's just clickable.
//
// Install: open GenTown > Settings > Add Mod, and paste the full URL where
// you're hosting this file (a raw GitHub link, GitHub Pages, etc.) - it
// isn't in R74nCom/GenTown-Mods, so the short-name shortcut won't resolve it.
//
// Everything under CONFIG-ish sections (trait numbers, chances, durations)
// is a starting point - tune freely once you see it play out.
// ============================================================================

(function () {

	// --- Traits -------------------------------------------------------------
	// happy/wealth: nudge to the town's mood/treasury while this trait's
	//   holder is in power. coupRisk: how much this trait raises (or, if
	//   negative, lowers) the leader's chance of facing an uprising.
	const TRAITS = {
		wise:        { name: "Wise",        line: "known for sound judgment",       happy:  0.15, wealth:  0,    coupRisk: -0.3 },
		cruel:       { name: "Cruel",       line: "who rules through fear",         happy: -0.25, wealth:  0.05, coupRisk:  0.5 },
		charismatic: { name: "Charismatic", line: "whose words move crowds",        happy:  0.2,  wealth:  0,    coupRisk: -0.2 },
		paranoid:    { name: "Paranoid",    line: "who trusts no one",              happy: -0.15, wealth:  0,    coupRisk:  0.3 },
		greedy:      { name: "Greedy",      line: "who enriches themself first",    happy: -0.2,  wealth:  0.25, coupRisk:  0.2 },
		generous:    { name: "Generous",    line: "who gives freely to the people", happy:  0.25, wealth: -0.15, coupRisk: -0.3 },
		brave:       { name: "Brave",       line: "who leads from the front",       happy:  0.05, wealth:  0,    coupRisk: -0.1 },
		frail:       { name: "Frail",       line: "whose health is failing",        happy:  0,    wealth:  0,    coupRisk:  0,   frail: true },
		ambitious:   { name: "Ambitious",   line: "who dreams of a greater town",   happy: -0.05, wealth:  0.1,  coupRisk:  0.1 },
		beloved:     { name: "Beloved",     line: "adored by the people",           happy:  0.3,  wealth:  0,    coupRisk: -0.4 },
	};

	function pickTraits(count) {
		let keys = Object.keys(TRAITS);
		let picked = [];
		while (picked.length < count && keys.length) {
			let t = choose(keys);
			picked.push(t);
			keys = keys.filter(k => k !== t);
		}
		return picked;
	}
	function traitLines(traits) {
		return traits.map(t => TRAITS[t].line).join(", ");
	}
	function traitSum(individual, field) {
		return (individual.traits || []).reduce((sum, t) => sum + (TRAITS[t][field] || 0), 0);
	}
	function randomName() {
		return generateWord(randRange(2, 3), true);
	}

	// --- Individuals ----------------------------------------------------------
	function createLeader(town, opts) {
		opts = opts || {};
		let traits = opts.traits || pickTraits(2);
		let ind = regAdd("individual", {
			name: opts.name || randomName(),
			type: "leader",
			role: "leader",
			town: town.id,
			traits: traits,
			age: opts.age !== undefined ? opts.age : randRange(20, 45),
			color: town.color,
			desc: `{{regname:town|${town.id}}}'s leader, ${traitLines(traits)}.` +
				(opts.introLine ? " " + opts.introLine : "")
		});
		town.leader = ind.id;
		return ind;
	}
	function endIndividual(ind, cause) {
		ind.end = planet.day;
		ind.cause = cause;
	}
	function noteHistory(ind, line) {
		ind.desc = (ind.desc || "") + "\n\n" + line;
	}

	function succeedLeader(town, cause, successor) {
		let oldLeader = regGet("individual", town.leader);
		if (oldLeader) endIndividual(oldLeader, cause);

		let heir = successor || regSingle("individual", (i) => i.town === town.id && i.role === "heir" && !i.end);

		let newLeader;
		if (heir) {
			heir.role = "leader";
			heir.type = "leader";
			heir.town = town.id;
			town.leader = heir.id;
			newLeader = heir;
		} else {
			let inheritedTrait = (oldLeader && Math.random() < 0.4) ? choose(oldLeader.traits) : null;
			let traits = inheritedTrait ? [inheritedTrait, ...pickTraits(1)] : pickTraits(2);
			newLeader = createLeader(town, {
				traits: traits,
				introLine: oldLeader ? `Rose to power after {{regname:individual|${oldLeader.id}}}.` : undefined
			});
			if (oldLeader && inheritedTrait) {
				newLeader.relations = [{ id: oldLeader.id, type: "family" }];
			}
		}

		logMessage(
			`{{regname:individual|${newLeader.id}}}, ${traitLines(newLeader.traits)}, becomes the new leader of {{regname:town|${town.id}}}` +
			(oldLeader ? ` following ${oldLeader.name}'s ${cause}.` : "."),
			"milestone"
		);

		return newLeader;
	}

	// --- Setup ------------------------------------------------------------
	Mod.afterLoad(function () {
		// NOTE: we deliberately don't touch reg/planet here. Mod.afterLoad
		// fires on the page's "load" event, which happens BEFORE a game is
		// actually started or loaded (planet is still null at that point) -
		// touching reg here throws and silently breaks the game's own
		// startup sequence (infinite loading screen). Assigning leaders to
		// existing towns is instead handled by the "individualAssignLeaders"
		// daily event below, which only ever runs once a game is live.

		// Surface leaders + traits on the town panel and on the individual's
		// own profile, using the game's existing info-panel system.
		regBrowserKeys["leader"] = "Leader";
		regBrowserValues["leader"] = (id) => `{{regname:individual|${id}}}`;

		regBrowserKeys["traits"] = "Traits";
		regBrowserValues["traits"] = (value) => (TRAITS[value] ? TRAITS[value].name : titleCase(value));

		regBrowserKeys["age"] = "Age";
		regBrowserValues["age"] = (value) => `${Math.floor(value)} years`;

		regBrowserKeys["individual.town"] = "Rules over";
		regBrowserValues["individual.town"] = (value) => `{{regname:town|${value}}}`;
	});

	// New towns (colonies, splits after a revolution, etc.) need leaders too -
	// this catches anything without one each day.
	Mod.event("individualAssignLeaders", {
		daily: true,
		subject: { reg: "town", all: true },
		func: (town) => {
			if (!town.leader || !regGet("individual", town.leader)) createLeader(town);
		}
	});

	// Leaders age, and older leaders have a rising chance of a natural death.
	Mod.event("individualAge", {
		daily: true,
		subject: { reg: "individual", all: true },
		func: (ind) => {
			if (ind.role !== "leader") return;
			ind.age += 1 / 20; // roughly 20 game-days per "year" - tune to taste
			let frailBonus = traitSum(ind, "frail") ? 0.4 : 0;
			let deathChance = Math.max(0, (ind.age - 50) / 4000) + frailBonus / 100;
			if (Math.random() < deathChance) {
				let town = regGet("town", ind.town);
				if (town) succeedLeader(town, "passing of old age");
			}
		}
	});

	// Day-to-day flavor: a leader's traits quietly nudge their town's mood
	// and treasury.
	Mod.event("individualRule", {
		daily: true,
		subject: { reg: "individual", all: true },
		func: (ind) => {
			if (ind.role !== "leader") return;
			let town = regGet("town", ind.town);
			if (!town) return;
			let happyMod = traitSum(ind, "happy") * 0.05;
			let wealthMod = Math.max(-5, Math.min(5, traitSum(ind, "wealth") * town.pop * 0.02));
			if (happyMod) happen("Influence", null, town, { happy: happyMod, temp: true });
			if (wealthMod) town.wealth = Math.max(0, (town.wealth || 0) + wealthMod);
		}
	});

	// Occasional trait-driven decree - flavorful, with a small consequence.
	Mod.event("individualDecree", {
		random: true,
		weight: $c.UNCOMMON,
		subject: { reg: "town", random: true },
		check: (town) => town.leader && !!regGet("individual", town.leader),
		func: (town) => {
			let leader = regGet("individual", town.leader);
			let decrees = [
				{ trait: "generous",    text: "opens the granaries to the poor",      happy:  1,   wealth: -0.05 },
				{ trait: "greedy",      text: "raises taxes to fund a new palace",    happy: -1,   wealth:  0.1 },
				{ trait: "wise",        text: "founds a council of elders",           happy:  0.5, wealth:  0 },
				{ trait: "cruel",       text: "makes an example of a dissenter",      happy: -1.5, wealth:  0 },
				{ trait: "ambitious",   text: "commissions a grand monument",         happy:  0.5, wealth: -0.1 },
				{ trait: "charismatic", text: "holds a festival in their own honor",  happy:  1,   wealth: -0.05 },
			];
			let matching = decrees.filter(d => leader.traits.includes(d.trait));
			let decree = choose(matching.length ? matching : decrees);
			if (decree.happy) happen("Influence", null, town, { happy: decree.happy, temp: true });
			if (decree.wealth) town.wealth = Math.max(0, (town.wealth || 0) + (town.wealth || 0) * decree.wealth);
			noteHistory(leader, `{{regname:individual|${leader.id}}} ${decree.text}.`);
			logMessage(`{{regname:individual|${leader.id}}} of {{regname:town|${town.id}}} ${decree.text}.`);
		}
	});

	// Cruel/paranoid leaders occasionally purge a rival.
	Mod.event("individualPurge", {
		random: true,
		weight: $c.RARE,
		subject: { reg: "town", random: true },
		check: (town) => {
			let leader = regGet("individual", town.leader);
			return !!leader && (leader.traits.includes("cruel") || leader.traits.includes("paranoid"));
		},
		func: (town) => {
			let leader = regGet("individual", town.leader);
			let rival = regSingle("individual", (i) => i.town === town.id && i.role === "rival" && !i.end)
				|| regAdd("individual", {
					name: randomName(), type: "rival", role: "rival", town: town.id,
					traits: pickTraits(1), age: randRange(20, 50), color: town.color,
					desc: `A rival of {{regname:individual|${leader.id}}} in {{regname:town|${town.id}}}.`
				});
			endIndividual(rival, "purge");
			happen("Influence", null, town, { happy: -1, temp: true });
			logMessage(`{{regname:individual|${leader.id}}} has {{regname:individual|${rival.id}}} purged, fearing a challenge to their rule.`, "warning");
		}
	});

	// If a town gets miserable enough under a risky leader, a coup can break
	// out. It's tracked as a "process", the same object type the base game
	// uses for wars/disasters/revolutions, so it resolves day by day and is
	// automatically picked up by the base game's own process dispatcher
	// (it looks for a meta event named "process"+TitleCase(type) - see
	// "processCoup" below).
	Mod.event("individualCoupStart", {
		daily: true,
		subject: { reg: "town", all: true },
		func: (town) => {
			if (town.issues.coup) return;
			let leader = regGet("individual", town.leader);
			if (!leader) return;
			if ((town.influences.happy || 0) >= -4) return;

			let coupRisk = 0.02 + traitSum(leader, "coupRisk") * 0.05;
			if (Math.random() > coupRisk) return;

			let rival = regSingle("individual", (i) => i.town === town.id && i.role === "rival" && !i.end)
				|| regAdd("individual", {
					name: randomName(), type: "rival", role: "rival", town: town.id,
					traits: pickTraits(2), age: randRange(25, 55), color: town.color,
					desc: `A challenger to {{regname:individual|${leader.id}}}'s rule over {{regname:town|${town.id}}}.`
				});

			let process = happen("Create", town, null, { type: "coup", duration: randRange(3, 6) }, "process");
			process.rival = rival.id;
			town.issues.coup = process.id;

			logMessage(`{{regname:individual|${rival.id}}} rallies support against {{regname:individual|${leader.id}}} in {{regname:town|${town.id}}}!`, "warning");
		}
	});

	Mod.event("processCoup", {
		meta: true,
		subject: { reg: "process" },
		func: (process) => {
			let town = regGet("town", process.town);
			if (!town || town.end) { happen("Finish", null, process); return; }

			process.duration--;
			happen("Influence", null, town, { happy: -0.3, temp: true });
			if (process.duration > 0) return;

			let leader = regGet("individual", town.leader);
			let rival = regGet("individual", process.rival);

			let leaderOdds = 0.5 + (town.jobs.soldier || 0) / Math.max(1, town.pop) * 2;
			if (leader) leaderOdds -= traitSum(leader, "coupRisk") * 0.3;
			leaderOdds = Math.min(0.9, Math.max(0.1, leaderOdds));

			if (Math.random() < leaderOdds) {
				if (rival) endIndividual(rival, "defeated coup");
				happen("Influence", null, town, { happy: -0.5, temp: true });
				if (leader) noteHistory(leader, `{{regname:individual|${leader.id}}} crushes a coup attempt.`);
				logMessage(`The coup against {{regname:individual|${leader.id}}} fails. {{regname:individual|${rival.id}}} is dealt with.`, "warning");
			} else {
				succeedLeader(town, "overthrow", rival);
			}

			happen("Finish", null, process);
		}
	});

})();
