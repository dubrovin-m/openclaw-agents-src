export const CALENDAR_TIME_ZONE = "Europe/Moscow";
export const BASELINE_START = "10:00";
export const BASELINE_END = "19:00";
const EPS = 0.01;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const finitePct = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const hexColor = (value) => typeof value === "string" && /^#[0-9A-Fa-f]{6}$/u.test(value);
const asRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
function sameSet(actual, expected) {
    return actual.length === expected.length && actual.every((value) => expected.includes(value));
}
function close(a, b) {
    return Math.abs(a - b) <= EPS;
}
function label(value, path) {
    const object = asRecord(value);
    if (!object || !nonEmpty(object.id) || !nonEmpty(object.name) || !hexColor(object.backgroundColor)) {
        throw new Error(`${path} must contain non-empty id/name and #RRGGBB backgroundColor`);
    }
    if (Object.keys(object).some((key) => !["id", "name", "backgroundColor"].includes(key))) {
        throw new Error(`${path} contains unsupported fields`);
    }
    return {
        id: object.id.trim(),
        name: object.name.trim(),
        backgroundColor: object.backgroundColor,
    };
}
function stringList(value, path, minItems = 1) {
    if (!Array.isArray(value) || value.length < minItems)
        throw new Error(`${path} must be an array with at least ${minItems} item(s)`);
    const result = value.map((item, index) => {
        if (!nonEmpty(item))
            throw new Error(`${path}[${index}] must be a non-empty string`);
        return item.trim();
    });
    if (new Set(result).size !== result.length)
        throw new Error(`${path} must contain unique values`);
    return result;
}
function targets(value, path) {
    const object = asRecord(value);
    if (!object)
        throw new Error(`${path} must be an object`);
    const result = {};
    for (const [key, pct] of Object.entries(object)) {
        if (!nonEmpty(key) || !finitePct(pct))
            throw new Error(`${path} contains an invalid target`);
        result[key] = pct;
    }
    return result;
}
export function parseCalendarConfig(value) {
    const root = asRecord(value);
    if (!root)
        throw new Error("Calendar configuration must be an object");
    const allowedRoot = ["designatedCalendar", "providerTools", "parents", "leaves", "unclassifiedLabel", "classificationRules", "targets"];
    if (Object.keys(root).some((key) => !allowedRoot.includes(key)))
        throw new Error("Calendar configuration contains unsupported fields");
    if (!nonEmpty(root.designatedCalendar))
        throw new Error("designatedCalendar is required");
    const provider = asRecord(root.providerTools);
    if (!provider || !nonEmpty(provider.prefix) || !Array.isArray(provider.read) || !nonEmpty(provider.classificationWrite) || !nonEmpty(provider.labelAdminWrite)) {
        throw new Error("providerTools requires prefix, read, classificationWrite, and labelAdminWrite");
    }
    if (Object.keys(provider).some((key) => !["prefix", "read", "classificationWrite", "labelAdminWrite"].includes(key))) {
        throw new Error("providerTools contains unsupported fields");
    }
    const prefix = provider.prefix.trim();
    const read = provider.read.map((item) => {
        if (!nonEmpty(item))
            throw new Error("providerTools.read must contain non-empty tool names");
        return item.trim();
    });
    if (read.length < 1 || new Set(read).size !== read.length)
        throw new Error("providerTools.read must contain unique tool names");
    const classificationWrite = provider.classificationWrite.trim();
    const labelAdminWrite = provider.labelAdminWrite.trim();
    if (!read.every((tool) => tool.startsWith(prefix)) || !classificationWrite.startsWith(prefix) || !labelAdminWrite.startsWith(prefix)) {
        throw new Error("Every configured Calendar provider tool must start with providerTools.prefix");
    }
    if (read.includes(classificationWrite) || read.includes(labelAdminWrite) || classificationWrite === labelAdminWrite) {
        throw new Error("Calendar provider write tools must be distinct from reads and from each other");
    }
    if (!Array.isArray(root.parents) || root.parents.length < 1)
        throw new Error("parents must be a non-empty array");
    const parents = root.parents.map((item, index) => {
        const object = asRecord(item);
        if (!object || !nonEmpty(object.id) || !nonEmpty(object.name)
            || Object.keys(object).some((key) => !["id", "name"].includes(key))) {
            throw new Error(`parents[${index}] is invalid`);
        }
        return { id: object.id.trim(), name: object.name.trim() };
    });
    if (new Set(parents.map((item) => item.id)).size !== parents.length)
        throw new Error("parent ids must be unique");
    if (!Array.isArray(root.leaves) || root.leaves.length < 1)
        throw new Error("leaves must be a non-empty array");
    const parentIds = new Set(parents.map((item) => item.id));
    const leaves = root.leaves.map((item, index) => {
        const object = asRecord(item);
        if (!object || !nonEmpty(object.id) || !nonEmpty(object.name)
            || (object.kind !== "management" && object.kind !== "service")
            || !nonEmpty(object.definition)
            || Object.keys(object).some((key) => !["id", "name", "kind", "parentId", "providerLabel", "definition", "includes", "excludes", "examples"].includes(key))) {
            throw new Error(`leaves[${index}] is invalid`);
        }
        const parentId = nonEmpty(object.parentId) ? object.parentId.trim() : undefined;
        if (object.kind === "management" && (!parentId || !parentIds.has(parentId))) {
            throw new Error(`management leaf ${object.id} must reference an existing parent`);
        }
        if (object.kind === "service" && parentId !== undefined) {
            throw new Error(`service leaf ${object.id} must not reference a management parent`);
        }
        return {
            id: object.id.trim(),
            name: object.name.trim(),
            kind: object.kind,
            ...(parentId ? { parentId } : {}),
            providerLabel: label(object.providerLabel, `leaves[${index}].providerLabel`),
            definition: object.definition.trim(),
            includes: stringList(object.includes, `leaves[${index}].includes`),
            excludes: stringList(object.excludes, `leaves[${index}].excludes`, 0),
            examples: stringList(object.examples, `leaves[${index}].examples`),
        };
    });
    if (new Set(leaves.map((item) => item.id)).size !== leaves.length)
        throw new Error("leaf ids must be unique");
    const providerIds = leaves.map((item) => item.providerLabel.id);
    const unclassifiedLabel = label(root.unclassifiedLabel, "unclassifiedLabel");
    providerIds.push(unclassifiedLabel.id);
    if (new Set(providerIds).size !== providerIds.length)
        throw new Error("provider label ids must be unique");
    const classificationRules = stringList(root.classificationRules, "classificationRules");
    const targetRoot = asRecord(root.targets);
    if (!targetRoot || Object.keys(targetRoot).some((key) => !["parents", "leaves"].includes(key))) {
        throw new Error("targets must contain only parents and leaves");
    }
    const parentTargets = targets(targetRoot.parents, "targets.parents");
    const leafTargets = targets(targetRoot.leaves, "targets.leaves");
    const managementLeaves = leaves.filter((item) => item.kind === "management");
    if (!sameSet(Object.keys(parentTargets), parents.map((item) => item.id))) {
        throw new Error("targets.parents must cover every parent exactly");
    }
    if (!sameSet(Object.keys(leafTargets), managementLeaves.map((item) => item.id))) {
        throw new Error("targets.leaves must cover every management leaf exactly");
    }
    const parentTotal = Object.values(parentTargets).reduce((sum, value) => sum + value, 0);
    const leafTotal = Object.values(leafTargets).reduce((sum, value) => sum + value, 0);
    if (!close(parentTotal, 100) || !close(leafTotal, 100))
        throw new Error("management targets must sum to 100%");
    for (const parent of parents) {
        const childTarget = managementLeaves
            .filter((leaf) => leaf.parentId === parent.id)
            .reduce((sum, leaf) => sum + leafTargets[leaf.id], 0);
        if (!close(childTarget, parentTargets[parent.id])) {
            throw new Error(`leaf targets for parent ${parent.id} must equal its parent target`);
        }
    }
    return {
        designatedCalendar: root.designatedCalendar.trim(),
        providerTools: { prefix, read, classificationWrite, labelAdminWrite },
        parents,
        leaves,
        unclassifiedLabel,
        classificationRules,
        targets: { parents: parentTargets, leaves: leafTargets },
    };
}
const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CALENDAR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
});
function zonedParts(epochMs) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]));
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
    };
}
function offsetAt(epochMs) {
    const p = zonedParts(epochMs);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return represented - Math.floor(epochMs / 1000) * 1000;
}
function parseClock(clock) {
    const match = /^(\d{2}):(\d{2})$/u.exec(clock);
    if (!match)
        throw new Error("invalid clock");
    return [Number(match[1]), Number(match[2])];
}
export function localDateTimeMs(date, clock) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
        throw new Error("invalid local date");
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = parseClock(clock);
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = target;
    for (let i = 0; i < 4; i += 1)
        guess = target - offsetAt(guess);
    return guess;
}
export function addCivilDays(date, days) {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}
export function localDate(epochMs) {
    const p = zonedParts(epochMs);
    return `${p.year.toString().padStart(4, "0")}-${p.month.toString().padStart(2, "0")}-${p.day.toString().padStart(2, "0")}`;
}
export function isWorkingDate(date) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5;
}
export function previousWorkingDates(endDate, count) {
    const dates = [];
    let cursor = endDate;
    while (dates.length < count) {
        if (isWorkingDate(cursor))
            dates.push(cursor);
        cursor = addCivilDays(cursor, -1);
    }
    return dates.reverse();
}
export function reviewWindow(kind, boundaryIso = new Date().toISOString()) {
    const boundaryMs = Date.parse(boundaryIso);
    if (!Number.isFinite(boundaryMs))
        throw new Error("boundary must be a valid ISO timestamp");
    const boundaryDate = localDate(boundaryMs);
    const workDates = kind === "daily"
        ? (isWorkingDate(boundaryDate) ? [boundaryDate] : [])
        : previousWorkingDates(boundaryDate, 10);
    if (kind === "daily" && workDates.length === 0) {
        throw new Error("Daily Review is not defined for weekends");
    }
    const first = workDates[0];
    const last = workDates[workDates.length - 1];
    const queryStartMs = localDateTimeMs(first, "00:00");
    const queryEndMs = localDateTimeMs(addCivilDays(last, 1), "00:00");
    return {
        kind,
        timeZone: CALENDAR_TIME_ZONE,
        boundary: new Date(boundaryMs).toISOString(),
        workDates,
        queryStart: new Date(queryStartMs).toISOString(),
        queryEnd: new Date(queryEndMs).toISOString(),
        baselineStart: BASELINE_START,
        baselineEnd: BASELINE_END,
    };
}
function pct(value, denominator) {
    return denominator > 0 ? value * 100 / denominator : null;
}
function hours(ms) {
    return Number((ms / 3_600_000).toFixed(4));
}
export function analyzeCalendar(configValue, kind, boundaryIso, eventsValue) {
    const config = parseCalendarConfig(configValue);
    const window = reviewWindow(kind, boundaryIso);
    if (!Array.isArray(eventsValue))
        throw new Error("events must be an array");
    const leafMap = new Map(config.leaves.map((leaf) => [leaf.id, leaf]));
    let excludedAllDayEvents = 0;
    const events = eventsValue.flatMap((item, index) => {
        const object = asRecord(item);
        if (!object || !nonEmpty(object.id) || !nonEmpty(object.start) || !nonEmpty(object.end)
            || (object.allDay !== undefined && typeof object.allDay !== "boolean")
            || Object.keys(object).some((key) => !["id", "start", "end", "allDay", "classification"].includes(key))) {
            throw new Error(`events[${index}] is invalid`);
        }
        const classification = object.classification === undefined || object.classification === null
            ? null
            : (nonEmpty(object.classification) ? object.classification.trim() : null);
        if (classification !== null && !leafMap.has(classification))
            throw new Error(`events[${index}] references an unknown classification`);
        if (object.allDay === true) {
            excludedAllDayEvents += 1;
            return [];
        }
        const start = Date.parse(object.start);
        const end = Date.parse(object.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            throw new Error(`events[${index}] has an invalid interval`);
        return [{ id: object.id.trim(), start, end, classification }];
    });
    const byLeafMs = Object.fromEntries(config.leaves.map((leaf) => [leaf.id, 0]));
    let totalLoadMs = 0;
    let outsideBaselineMs = 0;
    let freeBaselineMs = 0;
    let unclassifiedMs = 0;
    let overlapUnattributedMs = 0;
    let baselineMs = 0;
    for (const date of window.workDates) {
        const dayStart = localDateTimeMs(date, "00:00");
        const dayEnd = localDateTimeMs(addCivilDays(date, 1), "00:00");
        const baselineStart = localDateTimeMs(date, BASELINE_START);
        const baselineEnd = localDateTimeMs(date, BASELINE_END);
        baselineMs += baselineEnd - baselineStart;
        const clipped = events
            .map((event) => ({ ...event, start: Math.max(event.start, dayStart), end: Math.min(event.end, dayEnd) }))
            .filter((event) => event.end > event.start);
        const points = new Set([dayStart, dayEnd, baselineStart, baselineEnd]);
        for (const event of clipped) {
            points.add(event.start);
            points.add(event.end);
        }
        const boundaries = [...points].sort((a, b) => a - b);
        for (let i = 0; i < boundaries.length - 1; i += 1) {
            const start = boundaries[i];
            const end = boundaries[i + 1];
            if (end <= start)
                continue;
            const duration = end - start;
            const active = clipped.filter((event) => event.start < end && event.end > start);
            const inBaseline = start >= baselineStart && end <= baselineEnd;
            if (active.length === 0) {
                if (inBaseline)
                    freeBaselineMs += duration;
                continue;
            }
            totalLoadMs += duration;
            if (!inBaseline)
                outsideBaselineMs += duration;
            const classifications = new Set(active.map((event) => event.classification ?? "__UNCLASSIFIED__"));
            if (classifications.size !== 1) {
                overlapUnattributedMs += duration;
                continue;
            }
            const classification = [...classifications][0];
            if (classification === "__UNCLASSIFIED__") {
                unclassifiedMs += duration;
            }
            else {
                byLeafMs[classification] += duration;
            }
        }
    }
    const managementLeaves = config.leaves.filter((leaf) => leaf.kind === "management");
    const serviceLeaves = config.leaves.filter((leaf) => leaf.kind === "service");
    const managementMs = managementLeaves.reduce((sum, leaf) => sum + byLeafMs[leaf.id], 0);
    const serviceMs = serviceLeaves.reduce((sum, leaf) => sum + byLeafMs[leaf.id], 0);
    const classifiedMs = managementMs + serviceMs;
    const coverageBasisMs = classifiedMs + unclassifiedMs + overlapUnattributedMs;
    const byParentMs = Object.fromEntries(config.parents.map((parent) => [parent.id, 0]));
    for (const leaf of managementLeaves)
        byParentMs[leaf.parentId] += byLeafMs[leaf.id];
    const leafAllocation = Object.fromEntries(managementLeaves.map((leaf) => {
        const actual = pct(byLeafMs[leaf.id], managementMs);
        return [leaf.id, {
                hours: hours(byLeafMs[leaf.id]),
                actualPct: actual === null ? null : Number(actual.toFixed(2)),
                targetPct: config.targets.leaves[leaf.id],
                deltaPct: actual === null ? null : Number((actual - config.targets.leaves[leaf.id]).toFixed(2)),
            }];
    }));
    const parentAllocation = Object.fromEntries(config.parents.map((parent) => {
        const actual = pct(byParentMs[parent.id], managementMs);
        return [parent.id, {
                hours: hours(byParentMs[parent.id]),
                actualPct: actual === null ? null : Number(actual.toFixed(2)),
                targetPct: config.targets.parents[parent.id],
                deltaPct: actual === null ? null : Number((actual - config.targets.parents[parent.id]).toFixed(2)),
            }];
    }));
    return {
        window,
        hours: {
            scheduledLoad: hours(totalLoadMs),
            measuredWorkday: hours(baselineMs + outsideBaselineMs),
            management: hours(managementMs),
            service: hours(serviceMs),
            unclassified: hours(unclassifiedMs),
            overlapUnattributed: hours(overlapUnattributedMs),
            freeWithinBaseline: hours(freeBaselineMs),
            outsideBaselineLoad: hours(outsideBaselineMs),
        },
        coverage: {
            classificationPct: coverageBasisMs > 0 ? Number((classifiedMs * 100 / coverageBasisMs).toFixed(2)) : null,
            basisHours: hours(coverageBasisMs),
            excludedAllDayEvents,
        },
        parentAllocation,
        leafAllocation,
    };
}
