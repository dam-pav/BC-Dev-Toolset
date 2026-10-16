codeunit 50204 "BCD Scalar Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ZeroDateTimeValuesAreEmptyStrings()
    var
        Header: Record "BCD Probe Header";
        Values: JsonObject;
    begin
        // [SCENARIO] Undefined values are explicit empty strings, not null or midnight.
        CreateHeader(Header);
        Values := ReadValues(Header);
        Assert.AreEqual('', Value(Values, '20').AsText(), 'Zero date.');
        Assert.AreEqual('', Value(Values, '21').AsText(), 'Zero time.');
        Assert.AreEqual('', Value(Values, '22').AsText(), 'Zero datetime.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure DatesPreserveClosingAndCalendarBoundaries()
    var
        Header: Record "BCD Probe Header";
        Values: JsonObject;
        Closing: JsonObject;
        Token: JsonToken;
    begin
        // [SCENARIO] A closing date must retain its distinct identity on the wire.
        CreateHeader(Header);
        Header."Probe Date" := 20240229D;
        Header.Modify();
        Assert.AreEqual('2024-02-29', Value(ReadValues(Header), '20').AsText(), 'Leap day.');
        Header."Probe Date" := ClosingDate(20261231D);
        Header.Modify();
        Values := ReadValues(Header);
        Values.Get('20', Token);
        Closing := Token.AsObject();
        Assert.AreEqual('2026-12-31', Value(Closing, 'date').AsText(), 'Normal part of closing date.');
        Assert.IsTrue(Value(Closing, 'closing').AsBoolean(), 'Closing marker.');
        Header."Probe Date" := 17540101D;
        Header.Modify();
        Assert.AreEqual('1754-01-01', Value(ReadValues(Header), '20').AsText(), 'Qualified lower persisted boundary.');
        Header."Probe Date" := 99991231D;
        Header.Modify();
        Assert.AreEqual('9999-12-31', Value(ReadValues(Header), '20').AsText(), 'Maximum normal date.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure TimesPreserveMillisecondsAndDefinedMidnight()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] Defined midnight differs from undefined time; fractional zeros survive.
        CreateHeader(Header);
        Header."Probe Time" := 000000T;
        Header.Modify();
        Assert.AreEqual('00:00:00.000', Value(ReadValues(Header), '21').AsText(), 'Defined midnight.');
        Header."Probe Time" := 123456T;
        Header.Modify();
        Assert.AreEqual('12:34:56.000', Value(ReadValues(Header), '21').AsText(), 'Whole seconds.');
        Header."Probe Time" := 010203.010T;
        Header.Modify();
        Assert.AreEqual('01:02:03.010', Value(ReadValues(Header), '21').AsText(), 'Ten milliseconds.');
        Header."Probe Time" := 235959.999T;
        Assert.AreEqual('23:59:59.999', Format(Header."Probe Time", 0, 9), 'In-memory input before persistence.');
        Header.Modify();
        Header.Get(Header."Run ID", Header."Line No.");
        Assert.AreEqual(000000T, Header."Probe Time", 'Typed read confirms persistence rounded the end-of-day value to midnight.');
        Assert.AreEqual('00:00:00.000', Value(ReadValues(Header), '21').AsText(), 'Generic read must match persisted typed time.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure DateTimesPreserveUtcAndFractionalPrecision()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] XML parsing/encoding preserves the UTC instant across a DST boundary.
        CreateHeader(Header);
        Evaluate(Header."Probe DateTime", '2026-10-25T01:30:00.123Z', 9);
        Header.Modify();
        Assert.AreEqual('2026-10-25T01:30:00.123Z', Value(ReadValues(Header), '22').AsText(), 'UTC milliseconds.');
        Evaluate(Header."Probe DateTime", '2026-03-29T00:59:59Z', 9);
        Header.Modify();
        Assert.AreEqual('2026-03-29T00:59:59.000Z', Value(ReadValues(Header), '22').AsText(), 'Whole-second UTC.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure PrecisionAndCodeNormalizationArePreserved()
    var
        Header: Record "BCD Probe Header";
        Values: JsonObject;
    begin
        // [SCENARIO] Integer precision beyond JavaScript's safe range and BC Code normalization.
        CreateHeader(Header);
        Evaluate(Header."Probe BigInteger", '9223372036854775807', 9);
        Header."Probe Code" := '  mixed Code  ';
        Header.Modify();
        Values := ReadValues(Header);
        Assert.AreEqual('9223372036854775807', Value(Values, '25').AsText(), 'Signed 64-bit maximum is a string.');
        Assert.AreEqual('MIXED CODE', Value(Values, '26').AsText(), 'Persisted Code normalization.');
        Evaluate(Header."Probe BigInteger", '-9223372036854775808', 9);
        Header.Modify();
        Assert.AreEqual('-9223372036854775808', Value(ReadValues(Header), '25').AsText(), 'Signed 64-bit minimum.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ScalarReadsAreInvariantAcrossLanguageContexts()
    var
        Header: Record "BCD Probe Header";
        PreviousLanguage: Integer;
        FailureText: Text;
        Succeeded: Boolean;
    begin
        // [SCENARIO] Language changes cannot localize machine-readable scalar values.
        CreateHeader(Header);
        Header."Probe Date" := ClosingDate(20261231D);
        Header."Probe Time" := 010203.010T;
        Evaluate(Header."Probe DateTime", '2026-10-25T01:30:00.123Z', 9);
        Header.Modify();
        PreviousLanguage := GlobalLanguage();
        Succeeded := TryLanguageReads(Header);
        if not Succeeded then
            FailureText := GetLastErrorText();
        GlobalLanguage(PreviousLanguage);
        if not Succeeded then
            Error('%1', FailureText);
    end;

    [TryFunction]
    local procedure TryLanguageReads(Header: Record "BCD Probe Header")
    var
        Values: JsonObject;
        English: Text;
        Actual: Text;
    begin
        GlobalLanguage(1033);
        Values := ReadValues(Header);
        Values.WriteTo(English);
        GlobalLanguage(1031);
        Assert.AreEqual(1031, GlobalLanguage(), 'German language context must be active.');
        Values := ReadValues(Header);
        Values.WriteTo(Actual);
        Assert.AreEqual(English, Actual, 'German context must preserve wire scalars.');
        GlobalLanguage(1060);
        Assert.AreEqual(1060, GlobalLanguage(), 'Slovenian language context must be active.');
        Values := ReadValues(Header);
        Values.WriteTo(Actual);
        Assert.AreEqual(English, Actual, 'Slovenian context must preserve wire scalars.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure EarlierDateCandidatesAreRejectedAtPersistence()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] Regression: SQL's documented minimum is not this runtime's normal-date boundary.
        CreateHeader(Header);
        Header."Probe Date" := 17530101D;
        asserterror Header.Modify();
        Assert.ExpectedError('Probe Date');
        // Each expected error rolls back fixture setup too; use a new isolated record.
        CreateHeader(Header);
        Header."Probe Date" := 17530102D;
        asserterror Header.Modify();
        Assert.ExpectedError('Probe Date');
        CreateHeader(Header);
        Header."Probe Date" := 17531231D;
        asserterror Header.Modify();
        Assert.ExpectedError('Probe Date');
    end;

    local procedure CreateHeader(var Header: Record "BCD Probe Header")
    begin
        Header.Init();
        Header."Run ID" := CreateGuid();
        Header."Line No." := 1;
        Header.Insert();
    end;

    local procedure ReadValues(Header: Record "BCD Probe Header"): JsonObject
    var
        Service: Codeunit "BCD Data Service";
        Request: JsonObject;
        Response: JsonObject;
        Filter: JsonObject;
        Row: JsonObject;
        Filters: JsonArray;
        Fields: JsonArray;
        Rows: JsonArray;
        Token: JsonToken;
        Input: Text;
    begin
        Fields.ReadFrom('[20,21,22,25,26]');
        Filter.Add('fieldId', 1);
        Filter.Add('expression', Format(Header."Run ID", 0, 4));
        Filters.Add(Filter);
        Request.Add('tableId', Database::"BCD Probe Header");
        Request.Add('fieldIds', Fields);
        Request.Add('filters', Filters);
        Request.Add('pageSize', 1);
        Request.WriteTo(Input);
        Response.ReadFrom(Service.ReadRecords(Input));
        Response.Get('records', Token);
        Rows := Token.AsArray();
        Assert.AreEqual(1, Rows.Count(), 'One persisted fixture.');
        Rows.Get(0, Token);
        Row := Token.AsObject();
        Row.Get('values', Token);
        exit(Token.AsObject());
    end;

    local procedure Value(Object: JsonObject; Name: Text): JsonValue
    var
        Token: JsonToken;
    begin
        Object.Get(Name, Token);
        exit(Token.AsValue());
    end;

    var
        Assert: Codeunit "Library Assert";
}
