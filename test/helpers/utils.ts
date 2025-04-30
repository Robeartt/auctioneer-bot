import { PoolOracle, PoolV2, Positions, PositionsEstimate } from '@blend-capital/blend-sdk';
import { mockPool, mockPoolOracle } from './mocks';

/**
 * Assert that a and b are approximately equal, relative to the smaller of the two,
 * within epsilon as a percentage.
 * @param a
 * @param b
 * @param epsilon - The max allowed difference between a and b as a percentage of the smaller of the two
 */
export function expectRelApproxEqual(a: number, b: number, epsilon = 0.001) {
  expect(Math.abs(a - b) / Math.min(a, b)).toBeLessThanOrEqual(epsilon);
}

export function buildAuction(
  userPositions: Positions,
  auctionPercent: number,
  bid: string[],
  lot: string[],
  pool: PoolV2,
  oracle: PoolOracle
): [Positions, PositionsEstimate] {
  let positionsToAuction = new Positions(new Map([]), new Map(), new Map());
  bid.map((asset) => {
    let index = mockPool.metadata.reserveList.indexOf(asset);
    let amount = userPositions.liabilities.get(index)!;
    positionsToAuction.liabilities.set(index, amount);
  });

  lot.map((asset) => {
    let index = mockPool.metadata.reserveList.indexOf(asset);
    let amount = userPositions.collateral.get(index)!;
    positionsToAuction.collateral.set(index, amount);
  });

  let auctionPositionsEstimate = PositionsEstimate.build(
    mockPool,
    mockPoolOracle,
    positionsToAuction
  );
  let auctionPositionCF =
    auctionPositionsEstimate.totalEffectiveCollateral / auctionPositionsEstimate.totalSupplied;
  let auctionPositionLF =
    auctionPositionsEstimate.totalEffectiveLiabilities / auctionPositionsEstimate.totalBorrowed;
  let auctionIncentive = 1 + (1 - auctionPositionCF / auctionPositionLF) / 2;
  let withdrawnCollateralPct = Math.ceil(
    ((((auctionPositionsEstimate.totalBorrowed * auctionPercent) / 100) * auctionIncentive) /
      auctionPositionsEstimate.totalSupplied) *
      100
  );

  let auction = new Positions(new Map([]), new Map(), new Map());
  for (let [index, amount] of positionsToAuction.liabilities) {
    auction.liabilities.set(index, (amount * BigInt(auctionPercent)) / BigInt(100));
  }
  for (let [index, amount] of positionsToAuction.collateral) {
    auction.collateral.set(index, (amount * BigInt(withdrawnCollateralPct)) / BigInt(100));
  }

  const auctionEstimate = PositionsEstimate.build(mockPool, mockPoolOracle, auction);
  return [auction, auctionEstimate];
}
