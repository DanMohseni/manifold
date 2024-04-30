import { APIHandler } from 'api/helpers/endpoint'
import {
  createSupabaseDirectClient,
  getInstanceId,
  SupabaseDirectClient,
} from 'shared/supabase/init'
import { convertContract } from 'common/supabase/contracts'
import { PrivateUser } from 'common/user'
import { chunk, orderBy, uniqBy } from 'lodash'
import {
  from,
  renderSql,
  select,
  join,
  limit as lim,
  where,
  orderBy as order,
  leftJoin,
  groupBy,
} from 'shared/supabase/sql-builder'
import { buildArray, filterDefined } from 'common/util/array'
import { log } from 'shared/utils'
import { ContractComment } from 'common/comment'
import { Contract } from 'common/contract'
import { Bet } from 'common/bet'
import { adContract } from 'common/boost'
import { Repost } from 'common/repost'
import { DAY_MS } from 'common/util/time'

const userIdsToAverageTopicConversionScores: {
  [userId: string]: { [groupId: string]: number }
} = {}
const DEBUG = process.platform === 'darwin'
const DEBUG_TIME_FRAME = '30 minutes'
export const getFeed: APIHandler<'get-feed'> = async (props) => {
  const { limit, offset, ignoreContractIds } = props
  const pg = createSupabaseDirectClient()
  // Use random user ids so that postgres doesn't cache the query:
  const userId = DEBUG
    ? await pg.one(
        `select user_id from user_contract_interactions
            where created_time > now() - interval $1
            order by random() limit 1`,
        [DEBUG_TIME_FRAME],
        (r) => r.user_id as string
      )
    : props.userId

  if (userIdsToAverageTopicConversionScores[userId] === undefined) {
    await buildUserInterestsCache(userId)
  }
  const privateUser = await pg.one(
    `select data from private_users where id = $1`,
    [userId],
    (r) => r.data as PrivateUser
  )
  const {
    blockedByUserIds,
    blockedContractIds,
    blockedUserIds,
    blockedGroupSlugs,
  } = privateUser
  const blockedIds = blockedUserIds.concat(blockedByUserIds)

  const viewedContractsQuery = renderSql(
    select(
      `contract_id, max(greatest(ucv.last_page_view_ts, ucv.last_promoted_view_ts, ucv.last_card_view_ts)) AS latest_seen_time`
    ),
    from(`user_contract_views ucv`),
    where(`ucv.user_id = $1`, [userId]),
    groupBy(`contract_id`)
  )

  const blockedGroupsQuery = renderSql(
    select('1'),
    from(`group_contracts gc`),
    join(`groups g on gc.group_id = g.id`),
    where(`gc.contract_id = contracts.id`),
    where(`g.slug = any(array[$1])`, [blockedGroupSlugs])
  )

  const claimedAdsQuery = renderSql(
    select('1'),
    from(`txns`),
    where(`category = 'MARKET_BOOST_REDEEM'`),
    where(`to_id = $1`, [userId]),
    where(`from_id = market_ads.id`)
  )

  const adsJoin = renderSql(
    select(`market_ads.id, market_id, funds, cost_per_view`),
    from(`market_ads`),
    join(`contracts on market_ads.market_id = contracts.id`),
    where(`funds >= cost_per_view`),
    where(`contracts.close_time > now()`),
    where(`not exists (${claimedAdsQuery})`),
    order(`cost_per_view desc`),
    lim(50)
  )

  const baseQueryArray = (boosts = false) =>
    buildArray(
      !boosts
        ? select(
            `contracts.*, uti.avg_conversion_score as topic_conversion_score`
          )
        : select(
            `contracts.*, uti.avg_conversion_score as topic_conversion_score, ma.id as ad_id`
          ),
      from(
        `(select
               unnest(array[$1]) as group_id,
               unnest(array[$2]) as avg_conversion_score) as uti`,
        [
          Object.keys(userIdsToAverageTopicConversionScores[userId]),
          Object.values(userIdsToAverageTopicConversionScores[userId]),
        ]
      ),
      join(`groups on groups.id = uti.group_id`),
      join(`group_contracts on group_contracts.group_id = uti.group_id`),
      join(`contracts on contracts.id = group_contracts.contract_id`),
      // Another option: get the top 1000 contracts by uti.CS * contracts.CS and then filter by user_contract_views
      !boosts &&
        leftJoin(
          `(${viewedContractsQuery}) cv ON cv.contract_id = contracts.id and cv.latest_seen_time is null`
        ),
      where(`contracts.close_time > now() and contracts.visibility = 'public'`),
      where(
        `contracts.id not in (select contract_id from user_disinterests where user_id = $1 and contract_id = contracts.id)`,
        [userId]
      ),
      (ignoreContractIds?.length ?? 0) > 0 &&
        where(`contracts.id <> any(array[$1])`, [ignoreContractIds]),
      blockedIds.length > 0 &&
        where(`contracts.creator_id <> any(array[$1])`, [blockedIds]),
      blockedContractIds.length > 0 &&
        where(`contracts.id <> any(array[$1])`, [blockedContractIds]),
      blockedGroupSlugs.length > 0 &&
        where(`not exists (${blockedGroupsQuery})`),
      lim(limit, offset)
    )

  const adsQuery = renderSql(
    ...baseQueryArray(true),
    join(`(${adsJoin}) ma on ma.market_id = contracts.id`),
    order(
      `uti.avg_conversion_score  * contracts.conversion_score * ma.cost_per_view desc`
    )
  )

  const followedQuery = renderSql(
    ...baseQueryArray(),
    where(
      `contracts.creator_id in (select follow_id from user_follows where user_id = $1)`,
      [userId]
    ),
    order(`contracts.conversion_score desc`)
  )
  const sorts = {
    conversion: `uti.avg_conversion_score  * contracts.conversion_score desc`,
    importance: `uti.avg_conversion_score  * contracts.importance_score desc`,
    freshness: `uti.avg_conversion_score  * contracts.freshness_score desc`,
  }
  const sortQueries = Object.values(sorts).map((orderQ) =>
    renderSql(...baseQueryArray(), order(orderQ))
  )
  type contractAndMore = {
    contract: Contract
    topicConversionScore: number
    adId?: string
    comment?: ContractComment
    repost?: Repost
    bet?: Bet
  }
  if (DEBUG) {
    const explain = await pg.many(`explain analyze ${sortQueries[0]}`, [])
    log('explain:', explain.map((q) => q['QUERY PLAN']).join('\n'))
    const explainAds = await pg.many(`explain analyze ${adsQuery}`, [])
    log('explain:', explainAds.map((q) => q['QUERY PLAN']).join('\n'))
  }
  const startTime = Date.now()
  const [
    convertingContracts,
    importantContracts,
    freshContracts,
    followedContracts,
    adContracts,
    repostData,
  ] = await Promise.all([
    ...sortQueries.map((sortQuery) =>
      pg.map(
        sortQuery,
        [],
        (r) =>
          ({
            contract: convertContract(r),
            topicConversionScore: r.topic_conversion_score as number,
          } as contractAndMore)
      )
    ),
    pg.map(
      followedQuery,
      [],
      (r) =>
        ({
          contract: convertContract(r),
          topicConversionScore: r.topic_conversion_score as number,
        } as contractAndMore)
    ),
    pg.map(
      adsQuery,
      [],
      (r) =>
        ({
          adId: r.ad_id as string,
          contract: convertContract(r),
          topicConversionScore: r.topic_conversion_score as number,
        } as contractAndMore)
    ),
    pg.map(
      `select
         contracts.data as contract_data,
         contracts.importance_score,
         contracts.view_count,
         contracts.conversion_score,
         contracts.freshness_score,
         contract_comments.data as comment,
         contract_comments.likes as comment_likes,
         contract_bets.data as bet_data,
         posts.*
        from posts
           join user_contract_views ucv on posts.contract_id = ucv.contract_id and ucv.user_id = $1
           join contracts on posts.contract_id = contracts.id
           join contract_comments on posts.contract_comment_id = contract_comments.comment_id
           left join contract_bets on contract_comments.data->>'betId' = contract_bets.bet_id
            where posts.user_id in ( select follow_id from user_follows where user_id = $1)
            and posts.created_time > greatest(ucv.last_card_view_ts, ucv.last_page_view_ts)
            and posts.created_time > now() - interval '1 week'
        order by posts.created_time desc
        offset $2 limit $3
`,
      [userId, offset, limit],
      (r) => {
        const {
          contract_data,
          importance_score,
          view_count,
          freshness_score,
          conversion_score,
          comment,
          bet_data,
          comment_likes,
          ...rest
        } = r as any
        const timeDelta = Date.now() - new Date(r.created_time).getTime()
        const daysDelta = Math.max(Math.round(timeDelta / DAY_MS), 1)

        return {
          contract: convertContract({
            data: contract_data,
            importance_score: (importance_score + comment_likes) / daysDelta,
            view_count,
            freshness_score: (freshness_score + 1) / daysDelta,
            conversion_score,
          }),
          comment: {
            ...comment,
            likes: comment_likes,
          },
          bet: bet_data as Bet,
          // TODO: get topic conversion score to rank reposts as well
          topicConversionScore: 1,
          repost: rest,
        } as contractAndMore
      }
    ),
  ])
  log('feed queries completed in (s):', (Date.now() - startTime) / 1000, {
    userId,
    ignoreContractIds: ignoreContractIds?.length,
  })

  const contracts = uniqBy(
    orderBy(
      convertingContracts.concat(
        importantContracts,
        freshContracts,
        followedContracts,
        repostData
      ),
      (c) =>
        c.contract.conversionScore *
        c.contract.importanceScore *
        c.contract.freshnessScore *
        c.topicConversionScore,
      'desc'
    ).map((c) => c.contract),
    (c) => c.id
  )
  const idsToReason: { [id: string]: string } = Object.fromEntries(
    contracts.map((c) => [
      c.id,
      followedContracts.find((cc) => cc.contract.id === c.id)
        ? 'followed'
        : convertingContracts.find((cc) => cc.contract.id === c.id)
        ? 'conversion'
        : importantContracts.find((cc) => cc.contract.id === c.id)
        ? 'importance'
        : freshContracts.find((cc) => cc.contract.id === c.id)
        ? 'freshness'
        : '',
    ])
  )
  const ads = (adContracts as adContract[]).filter(
    (c) => !contracts.map((c) => c.id).includes(c.contract.id)
  )
  return {
    contracts,
    ads,
    idsToReason,
    comments: filterDefined(repostData.map((c) => c.comment)),
    bets: filterDefined(repostData.map((c) => c.bet)),
    reposts: filterDefined(repostData.map((c) => c.repost)),
  }
}

export const buildUserInterestsCache = async (userId?: string) => {
  log('Starting user topic interests cache build process')
  const pg = createSupabaseDirectClient(getInstanceId())
  const activeUserIds = filterDefined([userId])

  if (Object.keys(userIdsToAverageTopicConversionScores).length === 0) {
    const recentlyActiveUserIds = await pg.map(
      `select distinct user_id from user_contract_interactions
              where created_time > now() - interval $1`,
      [DEBUG ? DEBUG_TIME_FRAME : '1 month'],
      (r) => r.user_id as string
    )
    activeUserIds.push(...recentlyActiveUserIds)
  }
  log('building cache for users: ', activeUserIds.length)
  const chunks = chunk(activeUserIds, 500)
  for (const userIds of chunks) {
    await Promise.all([
      ...userIds.map(async (userId) => {
        userIdsToAverageTopicConversionScores[userId] = {}
        await pg.map(
          `SELECT * FROM get_user_topic_interests($1, 50) LIMIT 100`,
          [userId],
          (r) => {
            userIdsToAverageTopicConversionScores[userId][r.group_id] =
              r.avg_conversion_score
          }
        )
      }),
      addScoreForFollowedTopics(pg, userIds),
    ])
    log(
      'built topic interests cache for users: ',
      Object.keys(userIdsToAverageTopicConversionScores).length
    )
  }
  log('built user topic interests cache')
}

const addScoreForFollowedTopics = async (
  pg: SupabaseDirectClient,
  userIds: string[]
) => {
  await pg.map(
    `select member_id, group_id from group_members where member_id = any($1)`,
    [userIds],
    (row) => {
      if (!userIdsToAverageTopicConversionScores[row.member_id]) {
        userIdsToAverageTopicConversionScores[row.member_id] = {}
      }
      if (!userIdsToAverageTopicConversionScores[row.member_id][row.group_id]) {
        userIdsToAverageTopicConversionScores[row.member_id][row.group_id] = 0
      }
      userIdsToAverageTopicConversionScores[row.member_id][row.group_id] += 1
    }
  )
}
