import { APIError, APIHandler } from 'api/helpers/endpoint'
import { createSupabaseDirectClient } from 'shared/supabase/init'
import { ValidatedAPIParams } from 'common/api/schema'
import { log } from 'shared/utils'

const VIEW_COLUMNS = {
  card: ['last_card_view_ts', 'card_views'],
  promoted: ['last_promoted_view_ts', 'promoted_views'],
  page: ['last_page_view_ts', 'page_views'],
} as const

const viewQueue: ValidatedAPIParams<'record-contract-view'>[] = []
let queueProcessing = false
export const recordContractView: APIHandler<'record-contract-view'> = async (
  body,
  auth
) => {
  const { userId } = body
  if (userId !== auth?.uid) {
    throw new APIError(401, 'Can only insert views for own user ID.')
  }
  viewQueue.push(body)
  return {
    result: { status: 'success' },
    continue: async () => {
      if (!queueProcessing) {
        queueProcessing = true
        await processViewQueue()
          .catch((e) => log.error('Error processing view queue', e))
          .finally(() => (queueProcessing = false))
      }
    },
  }
}

const processViewQueue = async () => {
  const pg = createSupabaseDirectClient()
  while (viewQueue.length > 0) {
    const viewEvent = viewQueue.shift()!
    log(`Processing view, ${viewQueue.length} left.`, {
      viewEvent,
    })
    const { contractId, userId, kind } = viewEvent
    const [ts_column, count_column] = VIEW_COLUMNS[kind]
    // when we see an existing row, we need to bump the count by 1 and flip the timestamp to now.
    // for authed users, count at most one view per minute; for logged out users, count all
    await pg.none(
      `insert into user_contract_views as ucv (user_id, contract_id, $3:name, $4:name)
       values ($1, $2, now(), 1)
       on conflict (user_id, contract_id) do update set
         $3:name = excluded.$3:name, $4:name = ucv.$4:name + excluded.$4:name
       where $1 is null or ucv.$3:name is null or ucv.$3:name < now() - interval '1 minute'`,
      [userId ?? null, contractId, ts_column, count_column]
    )
  }
}
