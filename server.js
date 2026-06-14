const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname)));
const port = 3000;

const config = {
  user: 'db_ac8f14_sreport_admin',
  password: 'Sreport2026@',
  server: 'sql1001.site4now.net',
  database: 'db_ac8f14_sreport',
  options: { encrypt: true, trustServerCertificate: true },
  port: 1433
};

function buildRequest(pool, params = []) {
  const req = pool.request();
  params.forEach(p => req.input(p.name, p.type, p.value));
  return req;
}

app.get('/api/tables', async (req, res) => {
  try {
    let pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT TOP 200 TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `);
    res.json({ success: true, tables: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/schema/:table', async (req, res) => {
  // TODO: optional

  // For debugging route issues
  // console.log('[schema] raw table:', req.params.table);


  try {
    const table = req.params.table;
    const pool = await sql.connect(config);

    // Basic allowlist to avoid SQL injection via table name
    const allowAll = true;
    if (!allowAll) {
      return res.status(400).json({ success: false, error: 'Table not allowed' });
    }

    const cleanTable = table.replace(/^dbo\./,'');

    const result = await pool.request()
      .input('tableName', sql.VarChar, cleanTable)
      .query(`
        SELECT 
          COLUMN_NAME,
          DATA_TYPE,
          IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION
      `);

    res.json({ success: true, table: cleanTable, columns: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/dashboard', async (req, res) => {
  const { fromDate, toDate, reportType, category, priority } = req.query;

  try {
    let pool = await sql.connect(config);

    let whereClause = '';
    let params = [];
    if (fromDate) {
      whereClause += ' AND R.Date >= @fromDate';
      params.push({ name: 'fromDate', type: sql.DateTime, value: new Date(fromDate) });
    }
    if (toDate) {
      whereClause += ' AND R.Date <= @toDate';
      params.push({ name: 'toDate', type: sql.DateTime, value: new Date(toDate) });
    }
    if (reportType) {
      whereClause += ' AND R.Type = @reportType';
      params.push({ name: 'reportType', type: sql.VarChar, value: reportType });
    }
    // category => نعتمد إنها عمود عندك اسمه R.Category
    if (category) {
      whereClause += ' AND R.Category = @category';
      params.push({ name: 'category', type: sql.VarChar, value: category });
    }
    // priority => نعتمد إنها عمود عندك اسمه R.Priority
    if (priority) {
      whereClause += ' AND R.Priority = @priority';
      params.push({ name: 'priority', type: sql.VarChar, value: priority });
    }


    const W  = whereClause ? `WHERE 1=1 ${whereClause}` : '';
    const WA = W ? W + ' AND' : 'WHERE';

    // 1. KPI
    let [totalReports, openReports, closedReports, totalUsers] = await Promise.all([
      buildRequest(pool, params).query(`SELECT COUNT(*) as count FROM dbo.Reports R ${W}`),
      buildRequest(pool, params).query(`SELECT COUNT(*) as count FROM dbo.Reports R ${WA} R.State IN ('InProgress', 'Pending')`),
      buildRequest(pool, params).query(`SELECT COUNT(*) as count FROM dbo.Reports R ${WA} R.State = 'Resolved'`),
      pool.request().query(`SELECT COUNT(*) as count FROM dbo.Users`).catch(() => ({ recordset: [{ count: 0 }] })), ]);

    let totalCount  = totalReports.recordset[0].count || 0;
    let closedCount = closedReports.recordset[0].count || 0;
    let resolutionRate = totalCount > 0 ? ((closedCount / totalCount) * 100).toFixed(1) : 0;

    // 2. Status Breakdown
    let statusData = await buildRequest(pool, params).query(
      `SELECT State, COUNT(*) as count FROM dbo.Reports R ${W} GROUP BY State`
    );

    // 3. Cities
    let cityData = await buildRequest(pool, params).query(`
      SELECT C.Name, COUNT(R.Id) as count
      FROM dbo.Reports R
      JOIN dbo.Cities C ON R.CityId = C.Id
      ${W}
      GROUP BY C.Name
      ORDER BY count DESC
    `);

    // 4. Reports Over Time
    let reportsOverTime = await buildRequest(pool, params).query(`
      SELECT FORMAT(R.Date, 'MMM yyyy') as label,
             COUNT(*) as count
      FROM dbo.Reports R
      ${WA} R.Date >= DATEADD(month, -12, GETDATE())
      GROUP BY FORMAT(R.Date, 'MMM yyyy'), YEAR(R.Date), MONTH(R.Date)
      ORDER BY YEAR(R.Date), MONTH(R.Date)
    `);

    // 5. Resolution Rate Over Time
    let resolutionOverTime = await buildRequest(pool, params).query(`
      SELECT FORMAT(R.Date, 'MMM') as label,
             COUNT(*) as total,
             SUM(CASE WHEN R.State = 'Resolved' THEN 1 ELSE 0 END) as resolved
      FROM dbo.Reports R
      ${WA} R.Date >= DATEADD(month, -12, GETDATE())
      GROUP BY FORMAT(R.Date, 'MMM'), YEAR(R.Date), MONTH(R.Date)
      ORDER BY YEAR(R.Date), MONTH(R.Date)
    `);

    // 6. Trend Analysis: Reports by Day of Week
    let reportsByDayOfWeek = await buildRequest(pool, params).query(`
      SELECT DATENAME(dw, R.Date) as dayName, COUNT(*) as count
      FROM dbo.Reports R
      ${WA} R.Date >= DATEADD(day, -30, GETDATE())
      GROUP BY DATENAME(dw, R.Date), DATEPART(dw, R.Date)
      ORDER BY DATEPART(dw, R.Date)
    `);

    // 6b. Seasonal Analysis: Reports by Type and Month
    let reportsByTypeAndMonth = await buildRequest(pool, params).query(`
      SELECT TOP 20 
        R.Type,
        DATENAME(month, R.Date) as monthName,
        MONTH(R.Date) as monthNum,
        COUNT(*) as count
      FROM dbo.Reports R
      ${WA} R.Date >= DATEADD(month, -12, GETDATE())
      GROUP BY R.Type, DATENAME(month, R.Date), MONTH(R.Date), YEAR(R.Date)
      ORDER BY YEAR(R.Date), monthNum, R.Type
    `);

    // 6c. Most Active Volunteers (Users with most reports)
    let topVolunteers = await buildRequest(pool, params).query(`
      SELECT TOP 5
        U.Name as volunteerName,
        COUNT(R.Id) as reportCount,
        AVG(CAST(U.Rate AS float)) as avgRating
      FROM dbo.Reports R
      LEFT JOIN dbo.Users U ON U.Id = R.UserId
      ${WA} U.Name IS NOT NULL
      GROUP BY U.Id, U.Name
      ORDER BY reportCount DESC
    `).catch(() => ({ recordset: [] }));

    // 6d. Top Cities with most reports
    let topCities = await buildRequest(pool, params).query(`
      SELECT TOP 10
        C.Name as cityName,
        COUNT(R.Id) as reportCount,
        SUM(CASE WHEN R.State = 'Resolved' THEN 1 ELSE 0 END) as resolvedCount
      FROM dbo.Reports R
      LEFT JOIN dbo.Cities C ON R.CityId = C.Id
      ${WA} C.Name IS NOT NULL
      GROUP BY C.Id, C.Name
      ORDER BY reportCount DESC
    `).catch(() => ({ recordset: [] }));

    // 6e. Most Active Team per City (Governorate)
    let teamPerCity = await buildRequest(pool, params).query(`
      SELECT 
        C.Name as cityName,
        T.Name as teamName,
        COUNT(R.Id) as reportCount,
        SUM(CASE WHEN R.State = 'Resolved' THEN 1 ELSE 0 END) as closed
      FROM dbo.Reports R
      LEFT JOIN dbo.Cities C ON R.CityId = C.Id
      LEFT JOIN dbo.Teams T ON R.TeamId = T.Id
      ${W}
      GROUP BY C.Id, C.Name, T.Id, T.Name
    `).catch(() => ({ recordset: [] }));

    // تجميع أكثر تيم لكل مدينة
    const teamPerCityMap = {};
    teamPerCity.recordset.forEach(row => {
      if (!row.cityName || !row.teamName) return;
      if (!teamPerCityMap[row.cityName] || row.reportCount > teamPerCityMap[row.cityName].reportCount) {
        teamPerCityMap[row.cityName] = { teamName: row.teamName, reportCount: row.reportCount, closed: row.closed };
      }
    });
    const teamPerCityResult = Object.entries(teamPerCityMap).map(([city, v]) => ({
      city,
      teamName: v.teamName,
      reports: v.reportCount,
      closed: v.closed
    }));

    // 6f. Geographical Growth (مقارنة الشهر الحالي بالشهر اللي فاته)
    let geoGrowthReal = await buildRequest(pool, params).query(`
      SELECT
        SUM(CASE WHEN R.Date >= DATEADD(month, -1, GETDATE()) THEN 1 ELSE 0 END) as thisMonth,
        SUM(CASE WHEN R.Date >= DATEADD(month, -2, GETDATE()) AND R.Date < DATEADD(month, -1, GETDATE()) THEN 1 ELSE 0 END) as lastMonth
      FROM dbo.Reports R ${W}
    `).catch(() => ({ recordset: [{ thisMonth: 0, lastMonth: 0 }] }));

    const thisMonth = geoGrowthReal.recordset[0]?.thisMonth || 0;
    const lastMonthCount = geoGrowthReal.recordset[0]?.lastMonth || 0;
    const geoGrowthPct = lastMonthCount > 0 
      ? parseFloat(((thisMonth - lastMonthCount) / lastMonthCount * 100).toFixed(1))
      : (thisMonth > 0 ? 100 : 0);

    // 6. Type Breakdown
    let typeData = await buildRequest(pool, params).query(`
      SELECT TOP 5 Type, COUNT(*) as count
      FROM dbo.Reports R ${W}
      GROUP BY Type
      ORDER BY count DESC
    `);

    // 7. Fake vs Valid
    let fakeValid = await buildRequest(pool, params).query(`
      SELECT
        SUM(CASE WHEN IsValid = 1 THEN 1 ELSE 0 END) as valid,
        SUM(CASE WHEN IsValid = 0 OR IsValid IS NULL THEN 1 ELSE 0 END) as fake
      FROM dbo.Reports R ${W}
    `).catch(() => ({ recordset: [{ valid: 0, fake: 0 }] }));

    // 8. Teams (Ranking + Closed)
    let teamData = await buildRequest(pool, params).query(`
      SELECT T.Name as teamName,
             COUNT(R.Id) as totalReports,
             SUM(CASE WHEN R.State = 'Resolved' THEN 1 ELSE 0 END) as closed
      FROM dbo.Teams T
      LEFT JOIN dbo.Reports R ON R.TeamId = T.Id ${whereClause}
      GROUP BY T.Id, T.Name
      ORDER BY closed DESC
    `).catch(() => ({ recordset: [] }));

    // 9b. Time Metrics (Time to Assign + MTTR)
    let timeMetrics = await buildRequest(pool, params).query(`
      SELECT
        AVG(CASE WHEN RA.AssignedAt IS NOT NULL THEN DATEDIFF(minute, R.Date, RA.AssignedAt) ELSE NULL END) as avgAssignMinutes,
        AVG(CASE WHEN RA.AssignedAt IS NOT NULL AND RA.ResolvedAt IS NOT NULL THEN DATEDIFF(minute, RA.AssignedAt, RA.ResolvedAt) ELSE NULL END) as avgMttrMinutes
      FROM dbo.Reports R
      LEFT JOIN dbo.ReportAnalysis RA ON RA.ReportId = R.Id
      ${W}
    `).catch(() => ({ recordset: [{ avgAssignMinutes: 0, avgMttrMinutes: 0 }] }));

    const avgAssignMinutes = timeMetrics.recordset[0]?.avgAssignMinutes ?? 0;
    const avgMttrMinutes = timeMetrics.recordset[0]?.avgMttrMinutes ?? 0;

    const mttrHours = Math.floor(avgMttrMinutes / 60);
    const mttrMinutes = Math.round(avgMttrMinutes % 60);

    // 9c. Rating + Reliability from Users.Rate
    // Global (for avgRating + reliability distribution)
    let ratingMetrics = await buildRequest(pool, params).query(`
      SELECT
        AVG(CAST(U.Rate AS float)) as avgRating,
        SUM(CASE WHEN U.Rate >= 5 THEN 1 ELSE 0 END) as five,
        SUM(CASE WHEN U.Rate >= 4 AND U.Rate < 5 THEN 1 ELSE 0 END) as four,
        SUM(CASE WHEN U.Rate >= 3 AND U.Rate < 4 THEN 1 ELSE 0 END) as three,
        SUM(CASE WHEN U.Rate < 3 THEN 1 ELSE 0 END) as two
      FROM dbo.Reports R
      LEFT JOIN dbo.Users U ON U.Id = R.UserId
      ${W}
    `).catch(() => ({ recordset: [{ avgRating: null, two: 0, three: 0, four: 0, five: 0 }] }));

    const avgRating = ratingMetrics.recordset[0]?.avgRating;
    const twoCnt = ratingMetrics.recordset[0]?.two ?? 0;
    const threeCnt = ratingMetrics.recordset[0]?.three ?? 0;
    const fourCnt = ratingMetrics.recordset[0]?.four ?? 0;
    const fiveCnt = ratingMetrics.recordset[0]?.five ?? 0;

    // Team rating (real per team) - based on users rate on reports per TeamId
    // NOTE: This uses Reports.TeamId + Users.Rate. If your schema differs, adjust joins accordingly.
    let teamRatingMetrics = await buildRequest(pool, params).query(`
      SELECT
        T.Id as teamId,
        T.Name as teamName,
        AVG(CAST(U.Rate AS float)) as avgTeamRating
      FROM dbo.Teams T
      LEFT JOIN dbo.Reports R ON R.TeamId = T.Id
      LEFT JOIN dbo.Users U ON U.Id = R.UserId
      ${whereClause}
      GROUP BY T.Id, T.Name
    `).catch(() => ({ recordset: [] }));

    const teamRatingById = new Map(
      (teamRatingMetrics.recordset || []).map(r => [r.teamId, r.avgTeamRating])
    );


    // 9d. AI metrics from ReportAnalysis
    // ReportAnalysis.ConfidenceScore -> aiAccuracy
    // timeSaved: proxy calculation - assume AI saves time in initial triage
    let aiMetrics = await buildRequest(pool, params).query(`
      SELECT
        AVG(CAST(RA.ConfidenceScore AS float)) as avgConfidence,
        SUM(CASE WHEN RA.ConfidenceScore IS NOT NULL THEN 1 ELSE 0 END) as analyzedCount
      FROM dbo.Reports R
      LEFT JOIN dbo.ReportAnalysis RA ON RA.ReportId = R.Id
      ${W}
    `).catch(() => ({ recordset: [{ avgConfidence: null, analyzedCount: 0 }] }));

    const avgConfidenceAI = aiMetrics.recordset[0]?.avgConfidence;

    // Calculate timeSaved:
    // If ReportAnalysis has an explicit time saved column, use it; otherwise fallback to proxy.
    // (We can’t assume column name exists, so we proxy using Assign/Resolved durations as fallback.)
    const timeSaved = (avgAssignMinutes > avgMttrMinutes && avgAssignMinutes > 0)
      ? (avgAssignMinutes - avgMttrMinutes)
      : 0;


    // 9e. AI Priority breakdown from ReportAnalysis.ReportPriority

    let aiPriorityData = await buildRequest(pool, params).query(`
      SELECT TOP 5 RA.ReportPriority as priority, COUNT(*) as count
      FROM dbo.Reports R
      LEFT JOIN dbo.ReportAnalysis RA ON RA.ReportId = R.Id
      ${W}
      GROUP BY RA.ReportPriority
      ORDER BY count DESC
    `).catch(() => ({ recordset: [] }));

    // 9f. Most active team (by closed reports) from teamData already fetched.


    // 9. Geographical Stats (الجديد للبطاقة)
    let geoStats = await buildRequest(pool, params).query(`
      SELECT COUNT(DISTINCT CityId) as uniqueCities FROM dbo.Reports R ${W}
    `);
    


    let geoGrowthTrend = await buildRequest(pool, params).query(`
      SELECT TOP 10 COUNT(Id) as count FROM dbo.Reports R ${W} 
      GROUP BY CityId ORDER BY count ASC
    `);

    // 10. Recent Reports
    let recentReports = await buildRequest(pool, params).query(`
      SELECT TOP 10 R.Id, R.Description, R.State, R.Date, R.Type
      FROM dbo.Reports R ${W}
      ORDER BY R.Date DESC
    `);

    const teams = teamData.recordset;
    const fakeRow = fakeValid.recordset[0] || { valid: 0, fake: 0 };
    const totalCities = geoStats.recordset[0].uniqueCities || 0;
    const growthTrend = geoGrowthTrend.recordset.map(r => r.count);

    // Calculate areaType: Cities with above average reports vs below
    const avgReportsPerCity = totalCount > 0 && cityData.recordset.length > 0 ? totalCount / cityData.recordset.length : 0;
    const citiesAboveAvg = cityData.recordset.filter(c => c.count > avgReportsPerCity).length;
    const centersBelowAvg = cityData.recordset.length - citiesAboveAvg;

    res.json({
      success: true,
      data: {
        kpi: {
          totalReports: totalCount,
          openReports: openReports.recordset[0].count || 0,
          closedReports: closedCount,
          resolutionRate: parseFloat(resolutionRate),
          totalUsers: totalUsers.recordset[0].count || 0,
          totalNotifications: totalCount
        },
        statusBreakdown: {
          labels: statusData.recordset.map(r => r.State || 'Unknown'),
          data:   statusData.recordset.map(r => r.count),
          colors: ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"]
        },
        cities: cityData.recordset.map(r => ({ name: r.Name, reports: r.count })),
        reportsOverTime: {
          labels: reportsOverTime.recordset.map(r => r.label),
          data:   reportsOverTime.recordset.map(r => r.count)
        },
        resolutionRateOverTime: {
          labels: resolutionOverTime.recordset.map(r => r.label),
          data:   resolutionOverTime.recordset.map(r =>
            r.total > 0 ? parseFloat(((r.resolved / r.total) * 100).toFixed(1)) : 0)
        },
        reportsByDayOfWeek: {
          labels: reportsByDayOfWeek.recordset.map(r => r.dayName),
          data:   reportsByDayOfWeek.recordset.map(r => r.count)
        },
        reportsByTypeAndMonth: {
          labels: [...new Set(reportsByTypeAndMonth.recordset.map(r => r.monthName))],
          datasets: typeData.recordset.slice(0, 5).map((type, idx) => ({
            label: type.Type || 'Unknown',
            data: reportsByTypeAndMonth.recordset
              .filter(r => r.Type === type.Type)
              .map(r => r.count),
            borderColor: ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#9ca3af"][idx],
            backgroundColor: ["rgba(239, 68, 68, 0.1)", "rgba(59, 130, 246, 0.1)", "rgba(16, 185, 129, 0.1)", "rgba(245, 158, 11, 0.1)", "rgba(156, 163, 175, 0.1)"][idx],
            borderWidth: 2,
            fill: false,
            tension: 0.4
          }))
        },
        topVolunteers: topVolunteers.recordset.map((v, i) => ({
          rank: i + 1,
          name: v.volunteerName || `User ${i + 1}`,
          reports: v.reportCount || 0,
          rating: v.avgRating ? parseFloat(v.avgRating.toFixed(1)) : 0
        })),
        topCities: topCities.recordset.map(c => ({
          name: c.cityName || 'Unknown',
          reports: c.reportCount || 0,
          resolved: c.resolvedCount || 0
        })),
        topCategories: typeData.recordset.map(r => ({ category: r.Type || 'Unknown', count: r.count })),
        incidentCategories: {
          labels: typeData.recordset.map(r => r.Type || 'Unknown'),
          data:   typeData.recordset.map(r => r.count),
          colors: ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#9ca3af"]
        },
        priorityBreakdown: {
          labels: typeData.recordset.map(r => r.Type || 'Unknown'),
          data:   typeData.recordset.map(r => r.count),
          colors: ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6"]
        },
        aiPriority: {
          labels: aiPriorityData.recordset.map(r => r.priority || 'Unknown'),
          data:   aiPriorityData.recordset.map(r => r.count),
          colors: ["#ef4444", "#f59e0b", "#3b82f6", "#10b981", "#9ca3af"]
        },
        teamPerCity: teamPerCityResult,
        geographicalGrowth: {
          value: totalCities,
          percentage: geoGrowthPct,
          trend: growthTrend.length > 0 ? growthTrend : [0, 0, 0]
        },
        fakeValid: {
          labels: ["Valid", "Fake"],
          data:   [fakeRow.valid || 0, fakeRow.fake || 0],
          colors: ["#10b981", "#ef4444"]
        },
        reliability: { 
          labels: ["1-2 Stars", "3 Stars", "4 Stars", "5 Stars"], 
          data: [twoCnt, threeCnt, fourCnt, fiveCnt] 
        },
        teamRanking: teams.map((t, i) => ({
          rank: i + 1,
          name: t.teamName || `Team ${i + 1}`,
          closed: t.closed || 0,
          rating: (() => {
            const v = teamRatingById.get(t.teamId) ?? teamRatingById.get(t.Id);
            const n = v ?? avgRating;
            return n != null ? parseFloat(n) : 0;
          })()
        })),

        reportsPerTeam: {
          labels: teams.map(t => t.teamName || 'Unknown'),
          data:   teams.map(t => t.totalReports || 0)
        },
        teamTimeData: {
          labels:     teams.map(t => t.teamName || 'Unknown'),
          // if you later add per-team time, replace these arrays
          assignTime: teams.map(() => parseFloat(avgAssignMinutes / 60 || 0)),
          mttr:       teams.map(() => parseFloat(avgMttrMinutes / 60 || 0))
        },
        areaType: { labels: ["City", "Center"], data: [citiesAboveAvg, centersBelowAvg], colors: ["#3b82f6", "#f59e0b"] },
        avgTimeToAssign: parseFloat((avgAssignMinutes / 60).toFixed(2)),
        mttrHours: Math.floor(avgMttrMinutes / 60),
        mttrMinutes: Math.round(avgMttrMinutes % 60),
        // Quality / AI
        aiAccuracy: avgConfidenceAI != null ? parseFloat(avgConfidenceAI.toFixed(2)) : null,
        // Debug (temporarily): помогتا نعرف ليه aiAccuracy بيطلع null
        debugAi: {
          avgConfidenceAI: avgConfidenceAI,
          analyzedCount: aiMetrics?.recordset?.[0]?.analyzedCount ?? null
        },


        timeSaved: timeSaved,
        avgRating: avgRating,

        mostActiveTeam:    teams.length > 0 ? teams[0].teamName : 'N/A',
        mostActiveCount:   teams.length > 0 ? teams[0].closed : 0,
        avgReportsPerTeam: teams.length > 0 ? Math.round(totalCount / teams.length) : 0,
        topRatedTeam:  teams.length > 0 ? teams[0].teamName : 'N/A', // Use most active as proxy for top rated
        topRatedScore: avgRating != null ? parseFloat(avgRating) : null,
        avgWorkload:   teams.length > 0 ? parseFloat(((totalCount - closedCount) / teams.length).toFixed(1)) : 0,

        recentReports: recentReports.recordset.map(r => ({
          id:       r.Id,
          title:    r.Description ? r.Description.substring(0, 50) : 'No description',
          status:   r.State,
          date:     new Date(r.Date).toLocaleDateString(),
          priority: r.Type || 'N/A'
        }))
      }
    });

  } catch (err) {
    console.error("SQL Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/team-per-city', async (req, res) => {
  try {
    let pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT 
        C.Name as cityName,
        T.Name as teamName,
        COUNT(R.Id) as reportCount,
        SUM(CASE WHEN R.State = 'Resolved' THEN 1 ELSE 0 END) as closed
      FROM dbo.Reports R
      LEFT JOIN dbo.Cities C ON R.CityId = C.Id
      LEFT JOIN dbo.Teams T ON R.TeamId = T.Id
      WHERE C.Name IS NOT NULL AND T.Name IS NOT NULL
      GROUP BY C.Id, C.Name, T.Id, T.Name
      ORDER BY C.Name, reportCount DESC
    `);
    const cityMap = {};
    result.recordset.forEach(row => {
      if (!cityMap[row.cityName]) {
        cityMap[row.cityName] = { teamName: row.teamName, reports: row.reportCount, closed: row.closed };
      }
    });
    res.json({ success: true, data: Object.entries(cityMap).map(([city, v]) => ({ city, ...v })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/map', async (req, res) => {
  try {
    let pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT R.Id, R.Latitude, R.Longitude, R.State, R.Type, R.Description,
             C.Name as CityName, R.Date
      FROM dbo.Reports R
      LEFT JOIN dbo.Cities C ON R.CityId = C.Id
      WHERE R.Latitude IS NOT NULL AND R.Longitude IS NOT NULL
        AND R.Latitude != 0 AND R.Longitude != 0
    `);
    res.json({ success: true, reports: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index (2).html'));
});

app.listen(port, () => {
  console.log(`Server Running on http://localhost:${port}`);
});