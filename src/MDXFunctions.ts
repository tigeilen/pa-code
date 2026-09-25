/**
 * MDX function catalogue for the Cube Viewer's MDX editor, grouped by the same
 * categories PAW's Functions List uses. `insert` is the text dropped at the
 * cursor; a `§` marks where the caret should land (stripped on insert).
 * Sourced from the IBM Planning Analytics MDX Function Support reference.
 */
export interface MDXFunc { name: string; syntax: string; insert: string; desc: string; }
export interface MDXCategory { name: string; funcs: MDXFunc[]; }

export const MDX_FUNCTIONS: MDXCategory[] = [
    {
        name: 'Logical', funcs: [
            { name: 'IIF', syntax: 'IIF(search_condition, true_expr, false_expr)', insert: 'IIF(§, , )', desc: 'Returns one of two values depending on a condition.' },
            { name: 'IS', syntax: 'expr1 IS expr2', insert: '§ IS ', desc: 'True when two members/tuples are identical.' },
            { name: 'ISANCESTOR', syntax: 'ISANCESTOR(member1, member2)', insert: 'ISANCESTOR(§, )', desc: 'True when member1 is an ancestor of member2.' },
            { name: 'ISEMPTY', syntax: 'ISEMPTY(value_expr)', insert: 'ISEMPTY(§)', desc: 'True when the expression evaluates to empty.' },
            { name: 'ISGENERATION', syntax: 'ISGENERATION(member, generation_number)', insert: 'ISGENERATION(§, )', desc: 'True when the member is of the given generation.' },
            { name: 'ISLEAF', syntax: 'ISLEAF(member)', insert: 'ISLEAF(§)', desc: 'True when the member is a leaf (level 0).' },
            { name: 'ISSIBLING', syntax: 'ISSIBLING(member1, member2)', insert: 'ISSIBLING(§, )', desc: 'True when the two members are siblings.' },
            { name: 'CASE', syntax: 'CASE WHEN cond THEN val [...] ELSE val END', insert: 'CASE WHEN § THEN  ELSE  END', desc: 'Conditional expression with one or more WHEN branches.' }
        ]
    },
    {
        name: 'Member', funcs: [
            { name: 'ANCESTOR', syntax: 'ANCESTOR(member, distance|level)', insert: 'ANCESTOR(§, )', desc: 'The ancestor of a member at a distance or level.' },
            { name: 'COUSIN', syntax: 'COUSIN(member, ancestor)', insert: 'COUSIN(§, )', desc: 'The child in the same relative position under another ancestor.' },
            { name: 'OPENINGPERIOD', syntax: 'OPENINGPERIOD([level [, member]])', insert: 'OPENINGPERIOD(§)', desc: 'First descendant of a member at a level.' },
            { name: 'CLOSINGPERIOD', syntax: 'CLOSINGPERIOD([level [, member]])', insert: 'CLOSINGPERIOD(§)', desc: 'Last descendant of a member at a level.' },
            { name: 'PARALLELPERIOD', syntax: 'PARALLELPERIOD([level [, index [, member]]])', insert: 'PARALLELPERIOD(§, , )', desc: 'Member in a prior period parallel to a given member.' },
            { name: '.CurrentMember', syntax: 'hierarchy.CURRENTMEMBER', insert: '§.CURRENTMEMBER', desc: 'The current member of a hierarchy in context.' },
            { name: '.Parent', syntax: 'member.PARENT', insert: '§.PARENT', desc: 'The parent of a member.' },
            { name: '.FirstChild', syntax: 'member.FIRSTCHILD', insert: '§.FIRSTCHILD', desc: 'The first child of a member.' },
            { name: '.LastChild', syntax: 'member.LASTCHILD', insert: '§.LASTCHILD', desc: 'The last child of a member.' },
            { name: '.FirstSibling', syntax: 'member.FIRSTSIBLING', insert: '§.FIRSTSIBLING', desc: 'The first sibling of a member.' },
            { name: '.LastSibling', syntax: 'member.LASTSIBLING', insert: '§.LASTSIBLING', desc: 'The last sibling of a member.' },
            { name: '.PrevMember', syntax: 'member.PREVMEMBER', insert: '§.PREVMEMBER', desc: 'The previous member at the same level.' },
            { name: '.NextMember', syntax: 'member.NEXTMEMBER', insert: '§.NEXTMEMBER', desc: 'The next member at the same level.' },
            { name: '.Lag', syntax: 'member.LAG(index)', insert: '§.LAG()', desc: 'The member n positions before at the same level.' },
            { name: '.Lead', syntax: 'member.LEAD(index)', insert: '§.LEAD()', desc: 'The member n positions after at the same level.' },
            { name: '.DataMember', syntax: 'member.DATAMEMBER', insert: '§.DATAMEMBER', desc: 'The leaf data member associated with a consolidation.' },
            { name: '.DefaultMember', syntax: 'hierarchy.DEFAULTMEMBER', insert: '§.DEFAULTMEMBER', desc: 'The default member of a hierarchy.' },
            { name: 'STRTOMEMBER', syntax: 'STRTOMEMBER(member_string)', insert: 'STRTOMEMBER("§")', desc: 'Returns the member named by a string.' }
        ]
    },
    {
        name: 'Numeric', funcs: [
            { name: 'AGGREGATE', syntax: 'AGGREGATE(set [, numeric_expr])', insert: 'AGGREGATE(§)', desc: 'Aggregates the value over a set.' },
            { name: 'AVG', syntax: 'AVG(set [, numeric_expr])', insert: 'AVG(§)', desc: 'Average of a numeric expression over a set.' },
            { name: 'COUNT', syntax: 'COUNT(set [, INCLUDEEMPTY|EXCLUDEEMPTY])', insert: 'COUNT(§)', desc: 'Number of tuples in a set.' },
            { name: 'MAX', syntax: 'MAX(set [, numeric_expr])', insert: 'MAX(§)', desc: 'Maximum value over a set.' },
            { name: 'MIN', syntax: 'MIN(set [, numeric_expr])', insert: 'MIN(§)', desc: 'Minimum value over a set.' },
            { name: 'MEDIAN', syntax: 'MEDIAN(set [, numeric_expr])', insert: 'MEDIAN(§)', desc: 'Median value over a set.' },
            { name: 'SUM', syntax: 'SUM(set [, numeric_expr])', insert: 'SUM(§)', desc: 'Sum of a numeric expression over a set.' },
            { name: 'RANK', syntax: 'RANK(tuple, set [, numeric_expr])', insert: 'RANK(§, )', desc: 'Rank of a tuple within a set.' },
            { name: 'STDDEV', syntax: 'STDDEV(set [, numeric_expr])', insert: 'STDDEV(§)', desc: 'Sample standard deviation over a set.' },
            { name: 'VAR', syntax: 'VAR(set [, numeric_expr])', insert: 'VAR(§)', desc: 'Sample variance over a set.' },
            { name: 'CORRELATION', syntax: 'CORRELATION(set, y_expr [, x_expr])', insert: 'CORRELATION(§, )', desc: 'Correlation of two series over a set.' },
            { name: 'COVARIANCE', syntax: 'COVARIANCE(set, y_expr [, x_expr])', insert: 'COVARIANCE(§, )', desc: 'Covariance of two series over a set.' },
            { name: 'LINREGINTERCEPT', syntax: 'LINREGINTERCEPT(set, y_expr [, x_expr])', insert: 'LINREGINTERCEPT(§, )', desc: 'Linear-regression intercept.' },
            { name: 'LINREGPOINT', syntax: 'LINREGPOINT(x, set, y_expr [, x_expr])', insert: 'LINREGPOINT(§, , )', desc: 'Linear-regression predicted point.' },
            { name: 'LINREGR2', syntax: 'LINREGR2(set, y_expr [, x_expr])', insert: 'LINREGR2(§, )', desc: 'Linear-regression R² coefficient.' },
            { name: 'LINREGSLOPE', syntax: 'LINREGSLOPE(set, y_expr [, x_expr])', insert: 'LINREGSLOPE(§, )', desc: 'Linear-regression slope.' },
            { name: 'LINREGVARIANCE', syntax: 'LINREGVARIANCE(set, y_expr [, x_expr])', insert: 'LINREGVARIANCE(§, )', desc: 'Linear-regression variance.' }
        ]
    },
    {
        name: 'Set', funcs: [
            { name: 'ADDCALCULATEDMEMBERS', syntax: 'ADDCALCULATEDMEMBERS(set)', insert: 'ADDCALCULATEDMEMBERS(§)', desc: 'Adds calculated members to a set.' },
            { name: 'BOTTOMCOUNT', syntax: 'BOTTOMCOUNT(set, count [, numeric_expr])', insert: 'BOTTOMCOUNT(§, , )', desc: 'The lowest-N tuples by value.' },
            { name: 'BOTTOMPERCENT', syntax: 'BOTTOMPERCENT(set, percentage, numeric_expr)', insert: 'BOTTOMPERCENT(§, , )', desc: 'Lowest tuples summing to a percentage.' },
            { name: 'BOTTOMSUM', syntax: 'BOTTOMSUM(set, value, numeric_expr)', insert: 'BOTTOMSUM(§, , )', desc: 'Lowest tuples summing to a value.' },
            { name: 'CROSSJOIN', syntax: 'CROSSJOIN(set1, set2)', insert: 'CROSSJOIN(§, )', desc: 'The cross product of two sets.' },
            { name: 'DESCENDANTS', syntax: 'DESCENDANTS(member [, level [, flag]])', insert: 'DESCENDANTS(§, , )', desc: 'The descendants of a member.' },
            { name: 'DISTINCT', syntax: 'DISTINCT(set)', insert: 'DISTINCT(§)', desc: 'Removes duplicate tuples from a set.' },
            { name: 'DRILLDOWNLEVEL', syntax: 'DRILLDOWNLEVEL(set [, level|, index])', insert: 'DRILLDOWNLEVEL(§)', desc: 'Drills down the members of a set one level.' },
            { name: 'DRILLDOWNMEMBER', syntax: 'DRILLDOWNMEMBER(set1, set2 [, RECURSIVE])', insert: 'DRILLDOWNMEMBER(§, )', desc: 'Drills down specified members of a set.' },
            { name: 'DRILLUPMEMBER', syntax: 'DRILLUPMEMBER(set1, set2)', insert: 'DRILLUPMEMBER(§, )', desc: 'Drills up specified members of a set.' },
            { name: 'DRILLUPLEVEL', syntax: 'DRILLUPLEVEL(set [, level])', insert: 'DRILLUPLEVEL(§)', desc: 'Drills up the members of a set to a level.' },
            { name: 'EXCEPT', syntax: 'EXCEPT(set1, set2 [, ALL])', insert: 'EXCEPT(§, )', desc: 'Members of set1 not in set2.' },
            { name: 'EXTRACT', syntax: 'EXTRACT(set, hierarchy [, ...])', insert: 'EXTRACT(§, )', desc: 'Extracts hierarchies from a set of tuples.' },
            { name: 'FILTER', syntax: 'FILTER(set, search_condition)', insert: 'FILTER(§, )', desc: 'The tuples of a set that meet a condition.' },
            { name: 'GENERATE', syntax: 'GENERATE(set1, set2 [, ALL])', insert: 'GENERATE(§, )', desc: 'Applies a set expression to each tuple of a set.' },
            { name: 'HEAD', syntax: 'HEAD(set [, count])', insert: 'HEAD(§, )', desc: 'The first N tuples of a set.' },
            { name: 'TAIL', syntax: 'TAIL(set [, count])', insert: 'TAIL(§, )', desc: 'The last N tuples of a set.' },
            { name: 'HIERARCHIZE', syntax: 'HIERARCHIZE(set [, POST])', insert: 'HIERARCHIZE(§)', desc: 'Orders a set in hierarchy order.' },
            { name: 'INTERSECT', syntax: 'INTERSECT(set1, set2 [, ALL])', insert: 'INTERSECT(§, )', desc: 'The tuples common to two sets.' },
            { name: 'LASTPERIODS', syntax: 'LASTPERIODS(index [, member])', insert: 'LASTPERIODS(§, )', desc: 'A set of periods ending at a member.' },
            { name: 'ORDER', syntax: 'ORDER(set, expr [, ASC|DESC|BASC|BDESC])', insert: 'ORDER(§, , DESC)', desc: 'Sorts a set by an expression.' },
            { name: 'PERIODSTODATE', syntax: 'PERIODSTODATE([level [, member]])', insert: 'PERIODSTODATE(§, )', desc: 'A period-to-date set.' },
            { name: 'SUBSET', syntax: 'SUBSET(set, start [, count])', insert: 'SUBSET(§, , )', desc: 'A subset of a set from a start index.' },
            { name: 'TOPCOUNT', syntax: 'TOPCOUNT(set, count [, numeric_expr])', insert: 'TOPCOUNT(§, 10, )', desc: 'The highest-N tuples by value.' },
            { name: 'TOPPERCENT', syntax: 'TOPPERCENT(set, percentage, numeric_expr)', insert: 'TOPPERCENT(§, , )', desc: 'Highest tuples summing to a percentage.' },
            { name: 'TOPSUM', syntax: 'TOPSUM(set, value, numeric_expr)', insert: 'TOPSUM(§, , )', desc: 'Highest tuples summing to a value.' },
            { name: 'TOGGLEDRILLSTATE', syntax: 'TOGGLEDRILLSTATE(set1, set2 [, RECURSIVE])', insert: 'TOGGLEDRILLSTATE(§, )', desc: 'Toggles the drill state of members.' },
            { name: 'UNION', syntax: 'UNION(set1, set2 [, ALL])', insert: 'UNION(§, )', desc: 'The union of two sets.' },
            { name: '.Children', syntax: 'member.CHILDREN', insert: '§.CHILDREN', desc: 'The children of a member.' },
            { name: '.Members', syntax: 'hierarchy.MEMBERS / level.MEMBERS', insert: '§.MEMBERS', desc: 'All members of a hierarchy or level.' },
            { name: '.Siblings', syntax: 'member.SIBLINGS', insert: '§.SIBLINGS', desc: 'The siblings of a member.' }
        ]
    },
    {
        name: 'Property', funcs: [
            { name: '.PROPERTIES', syntax: 'member.PROPERTIES("attribute")', insert: '§.PROPERTIES("")', desc: 'The value of a member property/attribute.' },
            { name: '.VALUE', syntax: 'member.VALUE', insert: '§.VALUE', desc: 'The value of a member/cell.' },
            { name: '.NAME', syntax: 'member.NAME', insert: '§.NAME', desc: 'The name of a member/level/dimension.' },
            { name: '.UNIQUE_NAME', syntax: 'member.UNIQUE_NAME', insert: '§.UNIQUE_NAME', desc: 'The unique name of a member.' },
            { name: '.MEMBER_CAPTION', syntax: 'member.MEMBER_CAPTION', insert: '§.MEMBER_CAPTION', desc: 'The caption (display name) of a member.' },
            { name: '.MEMBER_VALUE', syntax: 'member.MEMBER_VALUE', insert: '§.MEMBER_VALUE', desc: 'The value of a member.' },
            { name: '.ORDINAL', syntax: 'level.ORDINAL', insert: '§.LEVEL.ORDINAL', desc: 'The level number (ordinal) of a member.' }
        ]
    },
    {
        name: 'String', funcs: [
            { name: 'MEMBERTOSTR', syntax: 'MEMBERTOSTR(member)', insert: 'MEMBERTOSTR(§)', desc: 'The string form of a member.' },
            { name: 'SETTOSTR', syntax: 'SETTOSTR(set)', insert: 'SETTOSTR(§)', desc: 'The string form of a set.' },
            { name: 'TUPLETOSTR', syntax: 'TUPLETOSTR(tuple)', insert: 'TUPLETOSTR(§)', desc: 'The string form of a tuple.' },
            { name: 'USERNAME', syntax: 'USERNAME', insert: 'USERNAME§', desc: 'The current user name.' },
            { name: 'GENERATE (string)', syntax: 'GENERATE(set, string_expr [, delimiter])', insert: 'GENERATE(§, , "")', desc: 'Concatenates a string built from each tuple.' }
        ]
    },
    {
        name: 'Miscellaneous', funcs: [
            { name: 'COALESCEEMPTY', syntax: 'COALESCEEMPTY(value_expr [, ...])', insert: 'COALESCEEMPTY(§, )', desc: 'The first non-empty value.' },
            { name: 'STRTOSET', syntax: 'STRTOSET(set_string)', insert: 'STRTOSET("§")', desc: 'Returns the set named by a string.' },
            { name: 'STRTOTUPLE', syntax: 'STRTOTUPLE(tuple_string)', insert: 'STRTOTUPLE("§")', desc: 'Returns the tuple named by a string.' },
            { name: 'NON EMPTY', syntax: 'NON EMPTY set', insert: 'NON EMPTY §', desc: 'Suppresses empty tuples on an axis.' }
        ]
    },
    {
        name: 'TM1', funcs: [
            { name: 'TM1SubsetAll', syntax: '{ TM1SubsetAll([dimension]) }', insert: '{TM1SubsetAll([§])}', desc: 'All members of a dimension (as a set).' },
            { name: 'TM1SubsetToSet', syntax: '{ TM1SubsetToSet([dimension], "subset") }', insert: '{TM1SubsetToSet([§], "")}', desc: 'The members of a named subset (as a set).' },
            { name: 'TM1FILTERBYLEVEL', syntax: 'TM1FILTERBYLEVEL(set, level_number)', insert: 'TM1FILTERBYLEVEL({§}, 0)', desc: 'The members of a set at a given level.' },
            { name: 'TM1FILTERBYPATTERN', syntax: 'TM1FILTERBYPATTERN(set, pattern [, attribute])', insert: 'TM1FILTERBYPATTERN({§}, "*")', desc: 'Members whose name/attribute matches a wildcard.' },
            { name: 'TM1SORT', syntax: 'TM1SORT(set, ASC|DESC)', insert: 'TM1SORT({§}, ASC)', desc: 'Sorts a set alphabetically.' },
            { name: 'TM1SORTBYINDEX', syntax: 'TM1SORTBYINDEX(set, ASC|DESC)', insert: 'TM1SORTBYINDEX({§}, ASC)', desc: 'Sorts a set by element index.' },
            { name: 'TM1DRILLDOWNMEMBER', syntax: 'TM1DRILLDOWNMEMBER(set1, set2|ALL [, RECURSIVE])', insert: 'TM1DRILLDOWNMEMBER({§}, ALL, RECURSIVE)', desc: 'Drills down members, TM1 variant.' },
            { name: 'TM1MEMBER', syntax: 'TM1Member(member, attribute)', insert: 'TM1MEMBER(§, )', desc: 'A member resolved by attribute value.' },
            { name: 'TM1TUPLESIZE', syntax: 'TM1TupleSize(tuple)', insert: 'TM1TUPLESIZE(§)', desc: 'The number of components in a tuple.' }
        ]
    }
];

export const MDX_SNIPPETS: { name: string; desc: string; mdx: string }[] = [
    { name: 'Basic SELECT', desc: 'Rows and columns from a cube', mdx: 'SELECT\n{ § } ON 0,\n{ } ON 1\nFROM [Cube]' },
    { name: 'All members of a dimension', desc: 'Every element of a hierarchy', mdx: '{ [Dimension].[Hierarchy].MEMBERS }' },
    { name: 'Leaf (level 0) members', desc: 'Only base-level elements', mdx: '{ TM1FILTERBYLEVEL( { TM1SUBSETALL([Dimension]) }, 0) }' },
    { name: 'Children of an element', desc: 'Immediate children of a consolidation', mdx: '{ DESCENDANTS([Dimension].[Element], 1) }' },
    { name: 'Named subset', desc: 'Members of an existing subset', mdx: '{ TM1SUBSETTOSET([Dimension], "SubsetName") }' },
    { name: 'Filter by name pattern', desc: 'Wildcard match on element names', mdx: '{ TM1FILTERBYPATTERN( { TM1SUBSETALL([Dimension]) }, "*text*") }' },
    { name: 'Top 10 by measure', desc: 'Highest 10 members by a value', mdx: '{ TOPCOUNT([Dimension].[Hierarchy].MEMBERS, 10, [Measures].[Value]) }' },
    { name: 'Order descending', desc: 'Sort members by a measure', mdx: '{ ORDER([Dimension].[Hierarchy].MEMBERS, [Measures].[Value], DESC) }' },
    { name: 'Non-empty axis', desc: 'Suppress empty rows', mdx: 'NON EMPTY { [Dimension].[Hierarchy].MEMBERS } ON 1' },
    { name: 'Crossjoin two dimensions', desc: 'Combine two sets on one axis', mdx: '{ CROSSJOIN( { [DimA].MEMBERS }, { [DimB].MEMBERS } ) }' },
    { name: 'Calculated member', desc: 'A WITH MEMBER calculation', mdx: "WITH MEMBER [Dimension].[Variance] AS '[Measures].[Actual] - [Measures].[Budget]'\nSELECT\n{ [Measures].MEMBERS } ON 0,\n{ [Dimension].MEMBERS } ON 1\nFROM [Cube]" }
];
