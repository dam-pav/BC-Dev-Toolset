codeunit 50209 "BCD Versioned Receipt Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure HistoricalReplayPrecedesStaleVersionCheck()
    var
        RunId: Guid;
        Original: JsonObject;
        Current: JsonObject;
        Request: Text;
        FirstResult: Text;
    begin
        Prepare(RunId, Original);
        Request := Mutation(RunId, CreateGuid(), Original, 4, false);
        FirstResult := Probe.Execute(Request);
        Commit();
        Current := State(RunId);
        Probe.Execute(Mutation(RunId, CreateGuid(), Row(Current), 9, false));
        Commit();
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Replay returns the original result despite stale token and later mutation.');
        CheckState(RunId, 9, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ChangedVersionForCompletedIdIsPayloadMismatch()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        RequestId := CreateGuid();
        Probe.Execute(Mutation(RunId, RequestId, Original, 4, false));
        Commit();
        Current := State(RunId);
        asserterror Probe.Execute(Mutation(RunId, RequestId, Row(Current), 4, false));
        Assert.ExpectedError('BCD_EV_REQUEST_ID_REUSED');
        CheckState(RunId, 4, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure StaleNewRequestRollsBackReservationThenFreshRetrySucceeds()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        Probe.Execute(Mutation(RunId, CreateGuid(), Original, 4, false));
        Commit();
        RequestId := CreateGuid();
        asserterror Probe.Execute(Mutation(RunId, RequestId, Original, 9, false));
        Assert.ExpectedError('BCD_E04_CONFLICT');
        CheckState(RunId, 4, 1, 1);
        Current := State(RunId);
        Probe.Execute(Mutation(RunId, RequestId, Row(Current), 9, false));
        Commit();
        CheckState(RunId, 9, 2, 2);
        Probe.Cleanup(RunRequest(RunId));
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure PostMutationFailureRollsBackVersionCounterAndReceipt()
    var
        RunId: Guid;
        RequestId: Guid;
        Original: JsonObject;
        Current: JsonObject;
    begin
        Prepare(RunId, Original);
        RequestId := CreateGuid();
        asserterror Probe.Execute(Mutation(RunId, RequestId, Original, 4, true));
        Assert.ExpectedError('BCD_EV_AFTER_MUTATION');
        Current := State(RunId);
        Assert.AreEqual(Value(Original, 'version'), Value(Row(Current), 'version'), 'Rolled back row has its original version.');
        CheckState(RunId, 0, 0, 0);
        Probe.Execute(Mutation(RunId, RequestId, Original, 4, false));
        Commit();
        CheckState(RunId, 4, 1, 1);
        Probe.Cleanup(RunRequest(RunId));
    end;

    local procedure Prepare(var RunId: Guid; var Original: JsonObject)
    begin
        RunId := CreateGuid();
        Original.ReadFrom(Probe.Prepare(RunRequest(RunId)));
        Commit();
    end;

    local procedure Mutation(RunId: Guid; RequestId: Guid; Target: JsonObject; Amount: Integer; Fail: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('requestId', Format(RequestId, 0, 4));
        Request.Add('systemId', Value(Target, 'systemId'));
        Request.Add('expectedVersion', Value(Target, 'version'));
        Request.Add('operation', 'modify');
        Request.Add('amount', Amount);
        Request.Add('failAfterMutation', Fail);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure State(RunId: Guid): JsonObject
    var
        Result: JsonObject;
    begin
        Result.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        exit(Result);
    end;

    local procedure Row(StateValue: JsonObject): JsonObject
    var
        Token: JsonToken;
    begin
        StateValue.Get('row', Token);
        exit(Token.AsObject());
    end;

    local procedure Value(Object: JsonObject; Name: Text): Text
    var
        Token: JsonToken;
    begin
        Object.Get(Name, Token);
        exit(Token.AsValue().AsText());
    end;

    local procedure CheckState(RunId: Guid; Amount: Integer; Applies: Integer; Receipts: Integer)
    var
        Actual: JsonObject;
    begin
        Actual := State(RunId);
        Assert.AreEqual(Format(Amount, 0, 9), Value(Row(Actual), 'amount'), 'Persisted amount.');
        Assert.AreEqual(Format(Applies, 0, 9), Value(Actual, 'applyCount'), 'Committed apply count.');
        Assert.AreEqual(Format(Receipts, 0, 9), Value(Actual, 'receiptCount'), 'Committed receipts.');
        Assert.AreEqual('0', Value(Actual, 'pendingCount'), 'No pending receipt remains.');
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    var
        Probe: Codeunit "BCD Versioned Receipt Probe";
        Assert: Codeunit "Library Assert";
}
