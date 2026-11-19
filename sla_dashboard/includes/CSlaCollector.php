<?php declare(strict_types = 0);

namespace Modules\SlaDashboard\Includes;

use API;
use DateInterval;
use DateTime;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Monta os dados do SLA dashboard. O SLI de cada serviço em cada período é calculado com as mesmas
 * regras do Zabbix (CSla::getSli/calculateSli do frontend 8.0): horário de serviço da SLA (schedule),
 * janelas excluídas (excluded downtimes), data de criação do serviço e status vindo de service_alarms
 * pela API (service.get selectStatusTimeline). A diferença é que os períodos não precisam ser os da SLA:
 * podem ser hora, dia, semana, mês ou ano, num intervalo de datas qualquer.
 *
 * Tudo passa pela API com a sessão do usuário, então as permissões do Zabbix valem como no SLA report.
 */
class CSlaCollector {

	public const MAX_BUCKETS = 500;

	private const INTERVALS = [
		CSlaFilter::PERIOD_HOUR => 'PT1H',
		CSlaFilter::PERIOD_DAY => 'P1D',
		CSlaFilter::PERIOD_WEEK => 'P1W',
		CSlaFilter::PERIOD_MONTH => 'P1M',
		CSlaFilter::PERIOD_YEAR => 'P1Y'
	];

	public static function collect(array $filter): array {
		$slas = API::Sla()->get([
			'output' => ['slaid', 'name', 'period', 'slo', 'timezone', 'effective_date', 'description'],
			'selectSchedule' => ['period_from', 'period_to'],
			'selectExcludedDowntimes' => ['name', 'period_from', 'period_to'],
			'selectServiceTags' => ['tag', 'operator', 'value'],
			'slaids' => $filter['slaids'] ?: null,
			'filter' => ['status' => ZBX_SLA_STATUS_ENABLED],
			'sortfield' => 'name',
			'preservekeys' => true
		]);

		$timezone = self::displayTimezone($slas);
		[$from, $to, $errors] = CSlaFilter::getRange($filter, $timezone);

		$result = [
			'period' => $filter['period'],
			'timezone' => $timezone->getName(),
			'from' => $from,
			'to' => $to,
			'now' => time(),
			'buckets' => [],
			'truncated' => false,
			'slas' => [],
			'services' => [],
			'rows' => [],
			'inherited' => [],
			'errors' => $errors
		];

		if ($errors || !$slas) {
			return $result;
		}

		// Não mostra períodos antes da SLA mais antiga começar a valer (o SLA report faz o mesmo).
		$effective = min(array_map(static fn($sla) => self::alignedEffective($sla), $slas));
		$buckets = self::buckets($filter['period'], max($from, $effective), $to, $timezone);
		if (count($buckets) > self::MAX_BUCKETS) {
			$buckets = array_slice($buckets, -self::MAX_BUCKETS);
			$result['truncated'] = true;
		}
		$result['buckets'] = $buckets;

		if (!$buckets) {
			return $result;
		}

		$range = ['period_from' => $buckets[0]['from'], 'period_to' => end($buckets)['to']];
		$serviceids = self::filterServiceids($filter);

		if ($serviceids !== null && !$serviceids) {
			return $result;
		}

		$tags = array_values(array_filter($filter['tags'], static fn($t) => $t['tag'] !== '' || $t['value'] !== ''));

		$services_by_sla = [];
		$own = [];
		foreach ($slas as $slaid => $sla) {
			$services_by_sla[$slaid] = API::Service()->get([
				'output' => ['serviceid', 'name', 'status', 'created_at'],
				'selectTags' => ['tag', 'value'],
				'selectStatusTimeline' => [$range],
				'slaids' => $slaid,
				'serviceids' => $serviceids,
				'evaltype' => $filter['evaltype'],
				'tags' => $tags ?: null,
				'sortfield' => 'name',
				'preservekeys' => true
			]);
			$own += $services_by_sla[$slaid];
		}

		foreach ($slas as $slaid => $sla) {
			$services = $services_by_sla[$slaid];

			// Componentes sem SLA própria (ex. a SLA casa uma tag que só o serviço pai tem): entram com a
			// SLA do ancestral, para a página mostrar a árvore inteira abaixo do serviço medido.
			$inherited = [];
			if ($services) {
				$descendants = array_diff(self::withDescendants(array_map('strval', array_keys($services))),
					array_map('strval', array_keys($own))
				);
				if ($serviceids !== null) {
					$descendants = array_intersect($descendants, $serviceids);
				}
				if ($descendants) {
					$inherited = API::Service()->get([
						'output' => ['serviceid', 'name', 'status', 'created_at'],
						'selectTags' => ['tag', 'value'],
						'selectStatusTimeline' => [$range],
						'serviceids' => array_values($descendants),
						'sortfield' => 'name',
						'preservekeys' => true
					]);
				}
			}

			$sla_start = self::alignedEffective($sla);
			$cells_by_bucket = [];
			foreach ($buckets as $b => $bucket) {
				$cells_by_bucket[$b] = $bucket['to'] <= $sla_start
					? null
					: self::scheduledPeriods($sla, $bucket);
			}

			$excluded = self::combineExcluded($sla['excluded_downtimes']);
			$sla_up = array_fill(0, count($buckets), 0);
			$sla_down = array_fill(0, count($buckets), 0);

			foreach ([false => $services, true => $inherited] as $is_inherited => $list) {
				foreach ($list as $serviceid => $service) {
					$result['services'][$serviceid] = [
						'name' => $service['name'],
						'status' => (int) $service['status'],
						'tags' => $service['tags']
					];

					$segments = self::segments($service['status_timeline'][0], $range['period_from'],
						min($range['period_to'], time())
					);
					$row = [
						'slaid' => (string) $slaid,
						'serviceid' => (string) $serviceid,
						'up' => 0, 'down' => 0, 'max' => 0,
						'cells' => []
					];

					foreach ($buckets as $b => $bucket) {
						if ($cells_by_bucket[$b] === null) {
							$row['cells'][] = null;
							continue;
						}
						$cell = self::cell($cells_by_bucket[$b], $excluded, (int) $service['created_at'], $segments);
						$row['up'] += $cell['up'];
						$row['down'] += $cell['down'];
						$row['max'] += $cell['max'];
						if (!$is_inherited) {
							$sla_up[$b] += $cell['up'];
							$sla_down[$b] += $cell['down'];
						}
						$row['cells'][] = $cell['up'] + $cell['down'] > 0
							? [round($cell['up'] / ($cell['up'] + $cell['down']) * 100, 4), $cell['down'], $cell['incidents']]
							: null;
					}

					$row += self::incidents($segments, max($range['period_from'], $sla_start), (int) $service['created_at']);
					$row['sli'] = $row['up'] + $row['down'] > 0 ? $row['up'] / ($row['up'] + $row['down']) * 100 : null;
					$row['budget'] = self::errorBudget($row['up'], $row['down'], $row['max'], (float) $sla['slo']);
					unset($row['max']);

					if ($is_inherited) {
						$result['inherited'][] = $row;
					}
					else {
						$result['rows'][] = $row;
					}
				}
			}

			$result['slas'][] = [
				'slaid' => (string) $slaid,
				'name' => $sla['name'],
				'slo' => (float) $sla['slo'],
				'period' => (int) $sla['period'],
				'timezone' => $sla['timezone'],
				'schedule' => (bool) $sla['schedule'],
				'excluded' => array_values(array_filter(array_map(static fn($d) => [
					'name' => $d['name'], 'from' => (int) $d['period_from'], 'to' => (int) $d['period_to']
				], $sla['excluded_downtimes']), static fn($d) => $d['to'] > $range['period_from'] && $d['from'] < $range['period_to'])),
				'services' => count($services),
				'series' => array_map(static fn($u, $d) => $u + $d > 0 ? round($u / ($u + $d) * 100, 4) : null,
					$sla_up, $sla_down
				)
			];
		}

		$result['nodes'] = $result['rows'] ? self::tree() : [];

		return $result;
	}

	/**
	 * Árvore de serviços visível ao usuário ({id: [nome, status, pais, filhos]}), para a navegação:
	 * a página mostra no topo os serviços medidos que não têm ancestral medido e desce pelos filhos
	 * (pulando os nós sem SLA, como a raiz de um provedor whitelabel).
	 */
	private static function tree(): array {
		$services = API::Service()->get([
			'output' => ['serviceid', 'name', 'status'],
			'selectParents' => ['serviceid'],
			'selectChildren' => ['serviceid'],
			'preservekeys' => true
		]);

		$nodes = [];
		foreach ($services as $id => $s) {
			$nodes[$id] = [
				$s['name'],
				(int) $s['status'],
				array_column($s['parents'], 'serviceid'),
				array_column($s['children'], 'serviceid')
			];
		}

		return $nodes;
	}

	/** Fuso dos períodos: o das SLAs quando todas usam o mesmo (como no SLA report), senão o do usuário. */
	private static function displayTimezone(array $slas): DateTimeZone {
		$zones = array_unique(array_map(static fn($sla) => $sla['timezone'] !== ZBX_DEFAULT_TIMEZONE
			? $sla['timezone']
			: \CTimezoneHelper::getSystemTimezone(), $slas
		));

		return new DateTimeZone(count($zones) == 1 ? reset($zones) : date_default_timezone_get());
	}

	private static function slaTimezone(array $sla): DateTimeZone {
		return new DateTimeZone($sla['timezone'] !== ZBX_DEFAULT_TIMEZONE
			? $sla['timezone']
			: \CTimezoneHelper::getSystemTimezone()
		);
	}

	/** Início do primeiro período da SLA (effective date alinhada ao período da SLA, como no core). */
	private static function alignedEffective(array $sla): int {
		$date = (new DateTime('@'.$sla['effective_date']))->setTimezone(self::slaTimezone($sla));
		$year = (int) $date->format('Y');
		$month = (int) $date->format('n');

		switch ((int) $sla['period']) {
			case ZBX_SLA_PERIOD_WEEKLY:
				$date->modify('1 day')->modify('last Sunday');
				break;
			case ZBX_SLA_PERIOD_MONTHLY:
				$date->setDate($year, $month, 1);
				break;
			case ZBX_SLA_PERIOD_QUARTERLY:
				$date->setDate($year, intdiv($month - 1, 3) * 3 + 1, 1);
				break;
			case ZBX_SLA_PERIOD_ANNUALLY:
				$date->setDate($year, 1, 1);
				break;
		}
		$date->setTime(0, 0);

		return $date->getTimestamp();
	}

	/** Períodos alinhados (hora cheia, dia, semana começando no domingo como no Zabbix, mês, ano). */
	private static function buckets(int $period, int $from, int $to, DateTimeZone $tz): array {
		$date = (new DateTime('@'.$from))->setTimezone($tz);
		$year = (int) $date->format('Y');

		switch ($period) {
			case CSlaFilter::PERIOD_HOUR:
				$date->setTime((int) $date->format('G'), 0);
				break;
			case CSlaFilter::PERIOD_WEEK:
				$date->modify('1 day')->modify('last Sunday')->setTime(0, 0);
				break;
			case CSlaFilter::PERIOD_MONTH:
				$date->setDate($year, (int) $date->format('n'), 1)->setTime(0, 0);
				break;
			case CSlaFilter::PERIOD_YEAR:
				$date->setDate($year, 1, 1)->setTime(0, 0);
				break;
			default:
				$date->setTime(0, 0);
		}

		$interval = new DateInterval(self::INTERVALS[$period]);
		$buckets = [];
		$guard = 0;

		while ($date->getTimestamp() < $to && $guard++ < 100000) {
			$start = $date->getTimestamp();
			$date->add($interval);
			$buckets[] = ['from' => $start, 'to' => $date->getTimestamp()];
		}

		return $buckets;
	}

	/** Port de CSla::getScheduledUptimePeriods(): horário de serviço da SLA dentro do período. */
	private static function scheduledPeriods(array $sla, array $bucket): array {
		$period = ['period_from' => $bucket['from'], 'period_to' => $bucket['to']];

		if (!$sla['schedule']) {
			return [$period];
		}

		$uptime_periods = [];
		$week_start = (new DateTimeImmutable('@'.$period['period_from']))
			->setTimezone(self::slaTimezone($sla))
			->modify('1 day')
			->modify('last Sunday');

		for ($week = 0;; $week++) {
			$week_from = $week_start->modify($week.' week');

			foreach ($sla['schedule'] as $row) {
				$p_from = $week_from
					->modify((int) ($row['period_from'] / SEC_PER_DAY).' day')
					->setTime((int) ($row['period_from'] / SEC_PER_HOUR) % 24, (int) ($row['period_from'] / SEC_PER_MIN) % 60,
						$row['period_from'] % 60
					)
					->getTimestamp();
				$p_to = $week_from
					->modify((int) ($row['period_to'] / SEC_PER_DAY).' day')
					->setTime((int) ($row['period_to'] / SEC_PER_HOUR) % 24, (int) ($row['period_to'] / SEC_PER_MIN) % 60,
						$row['period_to'] % 60
					)
					->getTimestamp();

				if ($p_from < $period['period_to'] && $p_to > $period['period_from']) {
					$new_from = max($period['period_from'], $p_from);
					$new_to = min($period['period_to'], $p_to);
					$last = count($uptime_periods) - 1;

					if ($uptime_periods && $uptime_periods[$last]['period_to'] == $new_from) {
						$uptime_periods[$last]['period_to'] = $new_to;
					}
					else {
						$uptime_periods[] = ['period_from' => $new_from, 'period_to' => $new_to];
					}
				}

				if ($p_to >= $period['period_to']) {
					break 2;
				}
			}
		}

		return $uptime_periods;
	}

	/** Port de CSla::combineExcludedDowntimes(). */
	private static function combineExcluded(array $excluded_downtimes): array {
		$combined = [];

		foreach ($excluded_downtimes as $downtime) {
			$from = (int) $downtime['period_from'];
			$to = (int) $downtime['period_to'];

			foreach ($combined as $c) {
				if ($downtime['period_from'] <= $c['period_to'] && $downtime['period_to'] >= $c['period_from']) {
					$from = min($from, $c['period_from']);
					$to = max($to, $c['period_to']);
				}
			}
			foreach ($combined as $i => $c) {
				if ($c['period_from'] >= $from && $c['period_to'] <= $to) {
					unset($combined[$i]);
				}
			}
			$combined[] = ['period_from' => $from, 'period_to' => $to];
		}

		return array_values($combined);
	}

	/** Linha do tempo do status em trechos [from, to, value], cortada no intervalo pedido e em "agora". */
	private static function segments(array $timeline, int $from, int $to): array {
		$segments = [];
		$prev_clock = $from;
		$prev_value = (int) $timeline['start_value'];

		foreach ($timeline['alarms'] as $alarm) {
			$clock = (int) $alarm['clock'];
			if ($clock > $prev_clock) {
				$segments[] = [$prev_clock, min($clock, $to), $prev_value];
			}
			$prev_clock = max($prev_clock, $clock);
			$prev_value = (int) $alarm['value'];
		}
		if ($to > $prev_clock) {
			$segments[] = [$prev_clock, $to, $prev_value];
		}

		return $segments;
	}

	/** Port de CSla::calculateSli() para uma célula (um serviço num período). */
	private static function cell(array $scheduled, array $excluded, int $created_at, array $segments): array {
		$cell = ['up' => 0, 'down' => 0, 'max' => 0, 'incidents' => 0];

		foreach ($scheduled as $sp) {
			$f = max($created_at, $sp['period_from']);
			$t = $sp['period_to'];
			if ($t - $f <= 0) {
				continue;
			}
			$cell['max'] += $t - $f - self::overlap($excluded, $f, $t);
		}

		$prev_value = ZBX_SEVERITY_OK;
		foreach ($segments as [$s_from, $s_to, $value]) {
			foreach ($scheduled as $sp) {
				$f = max($created_at, $sp['period_from'], $s_from);
				$t = min($sp['period_to'], $s_to);
				if ($t - $f <= 0) {
					continue;
				}
				$time = $t - $f - self::overlap($excluded, $f, $t);
				if ($value == ZBX_SEVERITY_OK) {
					$cell['up'] += $time;
				}
				else {
					$cell['down'] += $time;
					if ($prev_value == ZBX_SEVERITY_OK && $s_from >= $sp['period_from']) {
						$cell['incidents']++;
					}
				}
			}
			$prev_value = $value;
		}

		return $cell;
	}

	private static function overlap(array $excluded, int $from, int $to): int {
		$sum = 0;
		foreach ($excluded as $d) {
			$o = min($d['period_to'], $to) - max($d['period_from'], $from);
			if ($o > 0) {
				$sum += $o;
			}
		}

		return $sum;
	}

	/** Mesma fórmula do Zabbix: tempo de parada que ainda cabe no SLO (negativo = estourou). */
	private static function errorBudget(int $up, int $down, int $max, float $slo): ?int {
		if ($up + $down == 0) {
			return null;
		}
		$available = $max - $up - $down;

		return $slo > 0 ? min($available, (int) ($up / $slo * 100) - $up - $down) : $available;
	}

	/** Incidentes (OK → problema) e tempo médio até voltar (MTTR) no intervalo. */
	private static function incidents(array $segments, int $from, int $created_at): array {
		$count = 0;
		$durations = [];
		$open = null;
		$prev = ZBX_SEVERITY_OK;
		$start = max($from, $created_at);

		foreach ($segments as [$s_from, $s_to, $value]) {
			if ($s_to <= $start) {
				$prev = $value;
				continue;
			}
			if ($value != ZBX_SEVERITY_OK && $prev == ZBX_SEVERITY_OK) {
				$open = max($s_from, $start);
				$count++;
			}
			elseif ($value == ZBX_SEVERITY_OK && $prev != ZBX_SEVERITY_OK && $open !== null) {
				$durations[] = $s_from - $open;
				$open = null;
			}
			$prev = $value;
		}

		return [
			'incidents' => $count,
			'mttr' => $durations ? (int) round(array_sum($durations) / count($durations)) : null,
			'ongoing' => $prev != ZBX_SEVERITY_OK
		];
	}

	/**
	 * Serviços ligados aos hosts/grupos do filtro. Um serviço "é" do host quando as tags de problema dele
	 * casam com as tags que um problema daquele host teria (trigger + item + host + templates, que é de
	 * onde o Zabbix monta as tags do evento). Os serviços pais entram junto. Com o campo Service, só os
	 * escolhidos e os filhos deles. null = sem restrição.
	 */
	private static function filterServiceids(array $filter): ?array {
		$ids = null;

		if ($filter['serviceids']) {
			$ids = self::withDescendants($filter['serviceids']);
		}

		if ($filter['groupids'] || $filter['hostids']) {
			$by_host = self::servicesOfHosts($filter['groupids'], $filter['hostids']);
			$ids = $ids === null ? $by_host : array_values(array_intersect($ids, $by_host));
		}

		return $ids;
	}

	private static function withDescendants(array $serviceids): array {
		$all = array_fill_keys($serviceids, true);
		$queue = $serviceids;

		for ($depth = 0; $queue && $depth < 32; $depth++) {
			$children = API::Service()->get([
				'output' => ['serviceid'],
				'parentids' => $queue,
				'preservekeys' => true
			]);
			$queue = array_values(array_diff(array_keys($children), array_keys($all)));
			$all += array_fill_keys($queue, true);
		}

		return array_map('strval', array_keys($all));
	}

	private static function servicesOfHosts(array $groupids, array $hostids): array {
		$hosts = API::Host()->get([
			'output' => ['hostid'],
			'selectTags' => ['tag', 'value'],
			'selectInheritedTags' => ['tag', 'value'],
			'groupids' => $groupids ?: null,
			'hostids' => $hostids ?: null,
			'preservekeys' => true
		]);

		if (!$hosts) {
			return [];
		}

		$triggers = API::Trigger()->get([
			'output' => ['triggerid'],
			'selectTags' => ['tag', 'value'],
			'selectHosts' => ['hostid'],
			'selectItems' => ['itemid'],
			'hostids' => array_keys($hosts),
			'preservekeys' => true
		]);

		$itemids = [];
		foreach ($triggers as $trigger) {
			foreach ($trigger['items'] as $item) {
				$itemids[$item['itemid']] = true;
			}
		}
		$items = $itemids
			? API::Item()->get([
				'output' => ['itemid'],
				'selectTags' => ['tag', 'value'],
				'itemids' => array_keys($itemids),
				'webitems' => true,
				'preservekeys' => true
			])
			: [];

		$tag_sets = [];
		foreach ($triggers as $trigger) {
			$set = $trigger['tags'];
			foreach ($trigger['hosts'] as $host) {
				if (array_key_exists($host['hostid'], $hosts)) {
					$set = array_merge($set, $hosts[$host['hostid']]['tags'], $hosts[$host['hostid']]['inheritedTags']);
				}
			}
			foreach ($trigger['items'] as $item) {
				if (array_key_exists($item['itemid'], $items)) {
					$set = array_merge($set, $items[$item['itemid']]['tags']);
				}
			}
			$tag_sets[] = $set;
		}

		$services = API::Service()->get([
			'output' => ['serviceid'],
			'selectProblemTags' => ['tag', 'operator', 'value'],
			'selectParents' => ['serviceid'],
			'preservekeys' => true
		]);

		$matched = [];
		foreach ($services as $serviceid => $service) {
			if ($service['problem_tags'] && self::matchesAny($service['problem_tags'], $tag_sets)) {
				$matched[$serviceid] = true;
			}
		}

		// Sobe a árvore: o serviço de negócio que depende do host também é do host.
		$queue = array_keys($matched);
		while ($queue) {
			$id = array_pop($queue);
			foreach ($services[$id]['parents'] ?? [] as $parent) {
				if (!array_key_exists($parent['serviceid'], $matched)) {
					$matched[$parent['serviceid']] = true;
					$queue[] = $parent['serviceid'];
				}
			}
		}

		return array_map('strval', array_keys($matched));
	}

	/** Todas as tags de problema do serviço precisam casar com as tags de um mesmo evento. */
	private static function matchesAny(array $problem_tags, array $tag_sets): bool {
		foreach ($tag_sets as $set) {
			$all = true;
			foreach ($problem_tags as $pt) {
				$found = false;
				foreach ($set as $tag) {
					if ($tag['tag'] !== $pt['tag']) {
						continue;
					}
					if ($pt['operator'] == ZBX_SERVICE_PROBLEM_TAG_OPERATOR_EQUAL
							? $tag['value'] === $pt['value']
							: mb_stripos($tag['value'], $pt['value']) !== false) {
						$found = true;
						break;
					}
				}
				if (!$found) {
					$all = false;
					break;
				}
			}
			if ($all) {
				return true;
			}
		}

		return false;
	}
}
