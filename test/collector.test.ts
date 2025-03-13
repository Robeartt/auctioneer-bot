import { createFilter } from '../src/collector';

describe('createFilter', () => {
  it('should return an empty array when no pool ids are provided', () => {
    const poolConfigs: [] = [];
    const result = createFilter(poolConfigs);
    expect(result).toEqual([]);
  });

  it('should create a single filter with one contract ID when one pool config is provided', () => {
    const poolConfigs: string[] = ['pool1'];

    const expected = [
      {
        type: 'contract',
        contractIds: ['pool1'],
      },
    ];

    const result = createFilter(poolConfigs);
    expect(result).toEqual(expected);
  });

  it('should create a single filter when pool configs are less than or equal to 5', () => {
    const poolConfigs: string[] = ['pool1', 'pool2', 'pool3', 'pool4', 'pool5'];

    const expected = [
      {
        type: 'contract',
        contractIds: ['pool1', 'pool2', 'pool3', 'pool4', 'pool5'],
      },
    ];

    const result = createFilter(poolConfigs);
    expect(result).toEqual(expected);
  });

  it('should create multiple filters when pool configs are more than 5', () => {
    const poolConfigs: string[] = ['pool1', 'pool2', 'pool3', 'pool4', 'pool5', 'pool6', 'pool7'];

    const expected = [
      {
        type: 'contract',
        contractIds: ['pool1', 'pool2', 'pool3', 'pool4', 'pool5'],
      },
      {
        type: 'contract',
        contractIds: ['pool6', 'pool7'],
      },
    ];

    const result = createFilter(poolConfigs);
    expect(result).toEqual(expected);
  });

  it('should create exactly three filters for 11 pool configs', () => {
    const poolConfigs: string[] = Array.from({ length: 11 }, (_, i) => `pool${i + 1}`);

    const result = createFilter(poolConfigs);

    expect(result.length).toBe(3);
    expect(result[0].contractIds?.length).toBe(5);
    expect(result[1].contractIds?.length).toBe(5);
    expect(result[2].contractIds?.length).toBe(1);

    expect(result[0].type).toBe('contract');
    expect(result[1].type).toBe('contract');
    expect(result[2].type).toBe('contract');
  });
});
