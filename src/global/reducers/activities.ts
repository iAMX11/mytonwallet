import type { ApiActivity, ApiChain } from '../../api/types';
import type { AccountState, GlobalState } from '../types';

import {
  getActivityTokenSlugs,
  getIsIdSuitableForFetchingTimestamp,
  getIsTxIdLocal,
  mergeActivityIdsToMaxTime,
} from '../../util/activities';
import { compareActivities } from '../../util/compareActivities';
import {
  buildCollectionByKey, extractKey, mapValues, unique, uniqueByKey,
} from '../../util/iteratees';
import { selectAccountState } from '../selectors';
import { updateAccountState } from './misc';
import { updateCurrentSwap } from './swap';

/*
  Used for the initial activities insertion into `global`.
  Token activity IDs will just be replaced.
 */
export function putInitialActivities(
  global: GlobalState,
  accountId: string,
  mainActivities: ApiActivity[],
  bySlug: Record<string, ApiActivity[]>,
) {
  const allActivities = [...mainActivities, ...Object.values(bySlug).flat()];

  const { activities } = selectAccountState(global, accountId) || {};
  let { byId, idsBySlug, idsMain, newestActivitiesBySlug } = activities || {};

  byId = { ...byId, ...buildCollectionByKey(allActivities, 'id') };

  // Activities from different blockchains arrive separately, which causes the order to be disrupted
  idsMain = mergeActivityIdsToMaxTime(extractKey(mainActivities, 'id'), idsMain ?? [], byId);

  const newIdsBySlug = mapValues(bySlug, (_activities) => extractKey(_activities, 'id'));

  idsBySlug = { ...idsBySlug, ...newIdsBySlug };

  newestActivitiesBySlug = getNewestActivitiesBySlug(
    { byId, idsBySlug, newestActivitiesBySlug },
    Object.keys(newIdsBySlug),
  );

  return updateAccountState(global, accountId, {
    activities: {
      ...activities,
      idsMain,
      byId,
      idsBySlug,
      newestActivitiesBySlug,
    },
  });
}

export function addNewActivities(
  global: GlobalState,
  accountId: string,
  newActivities: ApiActivity[],
  lastMainListTimestamp?: number,
) {
  if (newActivities.length === 0) {
    return global;
  }

  const { activities } = selectAccountState(global, accountId) || {};
  let { byId, idsBySlug, idsMain, newestActivitiesBySlug, localActivities } = activities || {};

  byId = { ...byId, ...buildCollectionByKey(newActivities, 'id') };

  let forMain = newActivities;
  if (lastMainListTimestamp) {
    forMain = newActivities.filter(({ timestamp }) => timestamp >= lastMainListTimestamp);
  }

  // Activities from different blockchains arrive separately, which causes the order to be disrupted
  idsMain = mergeSortedActivityIds(extractKey(forMain, 'id'), idsMain ?? [], byId);

  const newIdsBySlug = buildActivityIdsBySlug(newActivities);
  const replacedIdsBySlug = mapValues(newIdsBySlug, (newIds, slug) => {
    // There may be newer local transactions in `idsBySlug`, so a sorting is needed
    return mergeSortedActivityIds(newIds, idsBySlug?.[slug] ?? [], byId);
  });
  idsBySlug = { ...activities?.idsBySlug, ...replacedIdsBySlug };

  newestActivitiesBySlug = getNewestActivitiesBySlug(
    { byId, idsBySlug, newestActivitiesBySlug },
    Object.keys(replacedIdsBySlug),
  );

  localActivities = uniqueByKey([
    ...(localActivities ?? []),
    ...newActivities.filter((activity) => getIsTxIdLocal(activity.id)),
  ], 'id');

  return updateAccountState(global, accountId, {
    activities: {
      ...activities,
      idsMain,
      byId,
      idsBySlug,
      newestActivitiesBySlug,
      localActivities,
    },
  });
}

function buildActivityIdsBySlug(activities: ApiActivity[]) {
  return activities.reduce<Record<string, string[]>>((acc, activity) => {
    for (const slug of getActivityTokenSlugs(activity)) {
      acc[slug] ??= [];
      acc[slug].push(activity.id);
    }

    return acc;
  }, {});
}

export function removeActivities(
  global: GlobalState,
  accountId: string,
  _ids: Iterable<string>,
) {
  const { activities } = selectAccountState(global, accountId) || {};
  if (!activities) {
    return global;
  }

  const ids = new Set(_ids); // Don't use `_ids` again, because the iterable may be disposable
  if (ids.size === 0) {
    return global;
  }

  let { byId, idsBySlug, idsMain, newestActivitiesBySlug, localActivities } = activities;
  const affectedTokenSlugs = getActivityListTokenSlugs(ids, byId);

  idsBySlug = { ...idsBySlug };
  for (const tokenSlug of affectedTokenSlugs) {
    if (tokenSlug in idsBySlug) {
      idsBySlug[tokenSlug] = idsBySlug[tokenSlug].filter((id) => !ids.has(id));

      if (!idsBySlug[tokenSlug].length) {
        delete idsBySlug[tokenSlug];
      }
    }
  }

  newestActivitiesBySlug = getNewestActivitiesBySlug({ byId, idsBySlug, newestActivitiesBySlug }, affectedTokenSlugs);

  idsMain = idsMain?.filter((id) => !ids.has(id));

  byId = { ...byId };
  for (const id of ids) {
    delete byId[id];
  }

  localActivities = localActivities?.filter((activity) => !ids.has(activity.id));

  return updateAccountState(global, accountId, {
    activities: {
      ...activities,
      byId,
      idsBySlug,
      idsMain,
      newestActivitiesBySlug,
      localActivities,
    },
  });
}

export function setIsInitialActivitiesLoadedTrue(global: GlobalState, accountId: string, chain: ApiChain) {
  const { byChain } = selectAccountState(global, accountId) ?? {};

  if (byChain && byChain[chain]?.isFirstTransactionsLoaded) {
    return global;
  }

  return updateAccountState(global, accountId, {
    byChain: {
      ...byChain,
      [chain]: {
        ...byChain?.[chain],
        isFirstTransactionsLoaded: true,
      },
    },
  });
}

export function updateActivity(global: GlobalState, accountId: string, activity: ApiActivity) {
  const { id } = activity;

  const { activities } = selectAccountState(global, accountId) || {};
  const { byId } = activities ?? {};

  if (!byId || !(id in byId)) {
    return global;
  }

  return updateAccountState(global, accountId, {
    activities: {
      ...activities,
      byId: {
        ...byId,
        [id]: activity,
      },
    },
  });
}

function mergeSortedActivityIds(ids0: string[], ids1: string[], byId: Record<string, ApiActivity>) {
  // Not the best performance, but ok for now
  return unique([...ids0, ...ids1]).sort((id0, id1) => compareActivities(byId[id0], byId[id1]));
}

function getNewestActivitiesBySlug(
  {
    byId, idsBySlug, newestActivitiesBySlug,
  }: Pick<Exclude<AccountState['activities'], undefined>, 'byId' | 'idsBySlug' | 'newestActivitiesBySlug'>,
  tokenSlugs: Iterable<string>,
) {
  newestActivitiesBySlug = { ...newestActivitiesBySlug };

  for (const tokenSlug of tokenSlugs) {
    // The `idsBySlug` arrays must be sorted from the newest to the oldest
    const ids = idsBySlug?.[tokenSlug] ?? [];
    const newestActivityId = ids.find((id) => getIsIdSuitableForFetchingTimestamp(id) && byId[id]);
    if (newestActivityId) {
      newestActivitiesBySlug[tokenSlug] = byId[newestActivityId];
    } else {
      delete newestActivitiesBySlug[tokenSlug];
    }
  }

  return newestActivitiesBySlug;
}

function getActivityListTokenSlugs(activityIds: Iterable<string>, byId: Record<string, ApiActivity>) {
  const tokenSlugs = new Set<string>();

  for (const id of activityIds) {
    const activity = byId[id];
    if (activity) {
      for (const tokenSlug of getActivityTokenSlugs(activity)) {
        tokenSlugs.add(tokenSlug);
      }
    }
  }

  return tokenSlugs;
}

/** replaceMap: keys - old (removed) activity ids, value - new (added) activity ids */
export function replaceCurrentActivityId(global: GlobalState, accountId: string, replaceMap: Map<string, string>) {
  const { currentActivityId } = selectAccountState(global, accountId) || {};
  const newActivityId = currentActivityId && replaceMap.get(currentActivityId);
  if (newActivityId) {
    global = updateAccountState(global, accountId, { currentActivityId: newActivityId });
  }
  return global;
}

/** replaceMap: keys - old (removed) activity ids, value - new (added) activity ids */
export function replaceCurrentSwapId(global: GlobalState, replaceMap: Map<string, string>) {
  const newSwapId = global.currentSwap.activityId && replaceMap.get(global.currentSwap.activityId);
  if (newSwapId !== undefined) {
    global = updateCurrentSwap(global, { activityId: newSwapId });
  }
  return global;
}
